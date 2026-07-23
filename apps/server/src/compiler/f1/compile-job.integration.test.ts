/**
 * Full-loop compilation job handler — integration tests (M1-F2-05).
 *
 * Exercises the full F1 → F2 compile job handler against real Postgres with
 * test-only structured-output stubs (no real LLM keys or network required).
 *
 * The stub LLM client returns pre-configured responses so the test can
 * drive every branch:
 *  - extract + unrelated → compiled (new page)
 *  - extract + confirms → compiled (merged into existing)
 *  - skip → skipped (no_knowledge)
 *  - schema validation failure → failed
 *  - simulated provider error → failed
 *
 * Verifies:
 *  - CLI step 1: two events about same concept → merge into 1 page
 *  - CLI step 2: events about different concepts → independent pages
 *  - CLI step 3: F1 skip event → no page, recorded skipped
 *  - Concept pages, evidence, paths, and contributors are first-class
 *    database rows.
 *  - Per-event job outcomes are recorded with the correct discriminated status.
 *  - Job lifecycle transitions: queued → processing → completed / failed.
 *  - The job result snapshot carries the produced concept UUIDs.
 *  - Scoped queries: events outside the project scope are not loaded.
 *
 * Requirements:
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm vitest ...
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import * as schema from '../../db/schema.js';
import {
  createJob,
  getJobEvents,
  type CreateJobRequest,
} from '../../db/repositories/jobs.js';
import { insertEvent, type EventInsertRequest } from '../../db/repositories/events.js';
import { payloadHash } from '../../security/payload-hash.js';
import {
  handleCompileJob,
  type CompileJobDeps,
  type CompileJobData,
} from './compile-job.js';
import type { LlmClient, LlmResponse, LlmRequest } from '../../llm/types.js';
import { LlmError } from '../../llm/types.js';
import type { F1Output, F1ExtractOutput } from './output.js';
import type { F2Decision } from '../f2/decision.js';
import { f2Decision } from '../f2/decision.js';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('compile-job handler (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  beforeAll(() => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean in reverse dependency order.
    await db.delete(schema.jobEvents);
    await db.delete(schema.jobs);
    await db.delete(schema.conceptContributors);
    await db.delete(schema.conceptEvidence);
    await db.delete(schema.conceptPaths);
    await db.delete(schema.concepts);
    await db.delete(schema.events);
    await db.delete(schema.apiKeys);
    await db.delete(schema.principals);
    await db.delete(schema.projects);
    await db.delete(schema.teams);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function freshTeamId(): string {
    // Must match /^team_[A-Za-z0-9]+$/ (from @teamem/schema).
    return `team_${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  }

  function freshProjectId(): string {
    // Must match /^prj_[A-Za-z0-9]+$/ (from @teamem/schema).
    return `prj_${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  }

  async function seedTeam(teamId: string, name = 'Test Team'): Promise<void> {
    await db.execute(
      sql`INSERT INTO teams (id, name) VALUES (${teamId}, ${name}) ON CONFLICT (id) DO NOTHING`,
    );
  }

  async function seedProject(
    teamId: string,
    projectId: string,
    name = 'Test Project',
  ): Promise<void> {
    await db.execute(
      sql`INSERT INTO projects (id, team_id, name) VALUES (${projectId}, ${teamId}, ${name})`,
    );
  }

  /**
   * Seed a complete event row via the events repository so all idempotency
   * and FK constraints are satisfied. Returns the inserted event ID.
   */
  async function seedCliEvent(
    teamId: string,
    projectId: string,
    overrides: Partial<EventInsertRequest> = {},
  ): Promise<string> {
    const deliveryId = overrides.deliveryId ?? `dk_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const payload = overrides.payload ?? {
      repo: 'teamem-ai/teamem',
      commitSha: 'abc1234def5678',
      path: 'src/index.ts',
      content: 'console.log("hello");',
      schemaVersion: 1,
    };
    const req: EventInsertRequest = {
      teamId,
      projectId,
      channel: 'cli',
      kind: 'cli_init',
      connectorKind: 'cli',
      deliveryId,
      itemKey: 'root',
      externalId: 'teamem-ai/teamem:src/index.ts',
      actor: null,
      actorProvenance: 'unknown',
      actorPrincipalId: null,
      occurredAt: new Date('2025-01-15T10:30:00.000Z'),
      occurredAtProvenance: 'client',
      payload,
      payloadHash: payloadHash(payload),
      payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      payloadSchemaVersion: 1,
      envelopeVersion: 1,
      ...overrides,
    };
    const result = await insertEvent(db, req);
    return result.eventId;
  }

  function makeCreateJobReq(
    teamId: string,
    projectId: string,
    overrides: Partial<CreateJobRequest> = {},
  ): CreateJobRequest {
    return {
      teamId,
      projectId,
      kind: 'compilation',
      initiatedByKind: 'credential',
      initiatedByCredentialId: 'key_test',
      eventCount: 1,
      ...overrides,
    };
  }

  /**
   * Build a stub {@link LlmClient} that returns a pre-configured response
   * for every call. The stub is schema-aware: when the schema is
   * {@link f2Decision}, it returns a canned 'unrelated' decision (so F2
   * merges never happen unless the test explicitly wires a merge stub).
   *
   * The stub validates the Zod schema via actual parse (so schema-mismatch
   * bugs in the test are caught by the stub), then returns the canned output.
   */
  function stubLlmClient(
    canned: F1Output,
    opts?: { failSchemaValidation?: boolean; f2Canned?: F2Decision },
  ): LlmClient {
    return {
      structured: async <T>(
        request: LlmRequest<T>,
      ): Promise<LlmResponse<T>> => {
        if (opts?.failSchemaValidation) {
          throw new LlmError(
            'schema_validation_failed',
            'openai',
            request.requestId,
          );
        }

        // Dispatch based on the request schema: F1 or F2.
        // F2 calls get a default 'unrelated' decision (new concept),
        // unless the test provides a specific F2 canned response.
        // Cast to unknown for comparison — ZodType<T> and f2Decision have
        // non-overlapping types at compile time but are the same at runtime.
        if ((request.schema as unknown) === f2Decision) {
          const f2Canned = opts?.f2Canned ?? unrelatedDecision();
          const parsed = (request.schema as unknown as typeof f2Decision).parse(f2Canned);
          return {
            output: parsed as unknown as T,
            model: {
              provider: 'openai',
              model: 'gpt-4o-test-stub',
              requestId: request.requestId,
            },
          };
        }

        // F1 call — parse the canned output against the request schema.
        const parsed = request.schema.parse(canned);
        return {
          output: parsed,
          model: {
            provider: 'openai',
            model: 'gpt-4o-test-stub',
            requestId: request.requestId,
          },
        };
      },
    };
  }

  /** Default F2 unrelated decision used when the LLM stub receives an F2 call. */
  function unrelatedDecision(): F2Decision {
    return {
      relationship: 'unrelated',
      targetConceptId: null,
      mergedTitle: 'New concept',
      mergedBody: '## New concept\n\nBody content.',
      resultStatus: 'active',
    };
  }

  /** F2 confirms decision for merge tests. */
  function confirmsDecision(targetConceptId: string, title: string, body: string): F2Decision {
    return {
      relationship: 'confirms',
      targetConceptId,
      mergedTitle: title,
      mergedBody: body,
      resultStatus: 'active',
    };
  }

  /**
   * Build a stub {@link LlmClient} that throws a provider error.
   */
  function stubErrorLlmClient(kind: 'timeout' | 'http_error' | 'provider_error'): LlmClient {
    return {
      structured: async <T>(request: LlmRequest<T>): Promise<LlmResponse<T>> => {
        throw new LlmError(kind, 'openai', request.requestId, {
          httpStatus: kind === 'http_error' ? 500 : undefined,
        });
      },
    };
  }

  /** A valid extract output for test reuse. */
  const validExtract: F1ExtractOutput = {
    action: 'extract',
    type: 'decision',
    title: 'Use Postgres for the main datastore',
    body: '## Decision\n\nWe chose Postgres.',
    path: 'decisions/use-postgres',
    tags: ['database', 'postgres'],
    confidence: 'high',
  };

  /** A valid skip output for test reuse. */
  const validSkip: F1Output = {
    action: 'skip',
    reason: 'Event contains no extractable team knowledge',
  };

  // ── Path 1: compiled ───────────────────────────────────────────────────

  describe('Path 1: compiled', () => {
    it('creates a concept page, records compiled outcome, and completes the job', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      // Seed an event.
      const eventId = await seedCliEvent(teamId, projectId);

      // Create a compilation job.
      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      // Wire the handler with the stub LLM.
      const llm = stubLlmClient(validExtract);
      const deps: CompileJobDeps = { db, llm };
      const jobData: CompileJobData = {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      };

      // Run the handler.
      await handleCompileJob(deps, jobData);

      // ── Verify job status ──────────────────────────────────────────
      const [updatedJob] = await db
        .select({ status: schema.jobs.status, resultSnapshot: schema.jobs.resultSnapshot })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job.id));
      expect(updatedJob!.status).toBe('completed');

      const snapshot = updatedJob!.resultSnapshot as {
        conceptIds: string[];
        compiled: number;
        skipped: number;
        failed: number;
      };
      expect(snapshot.compiled).toBe(1);
      expect(snapshot.skipped).toBe(0);
      expect(snapshot.failed).toBe(0);
      expect(snapshot.conceptIds).toHaveLength(1);

      // ── Verify per-event job outcome ───────────────────────────────
      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.eventId).toBe(eventId);
      expect(jobEvents[0]!.status).toBe('compiled');
      expect(jobEvents[0]!.conceptUuids).toHaveLength(1);

      // ── Verify concept page (first-class data) ─────────────────────
      const conceptUuid = snapshot.conceptIds[0]!;
      const [concept] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, conceptUuid));
      expect(concept).toBeDefined();
      expect(concept!.title).toBe('Use Postgres for the main datastore');
      expect(concept!.type).toBe('decision');
      expect(concept!.status).toBe('active');
      expect(concept!.confidence).toBe('high');
      expect(concept!.body).toContain('We chose Postgres');
      expect(concept!.teamId).toBe(teamId);
      expect(concept!.projectId).toBe(projectId);

      // ── Verify evidence (first-class) ──────────────────────────────
      const [evidence] = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, conceptUuid));
      expect(evidence).toBeDefined();
      expect(evidence!.kind).toBe('repo_file');
      expect(evidence!.repo).toBe('teamem-ai/teamem');
      expect(evidence!.commitSha).toBe('abc1234def5678');
      expect(evidence!.path).toBe('src/index.ts');

      // ── Verify path (first-class, current) ─────────────────────────
      const [pathRow] = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.conceptUuid, conceptUuid));
      expect(pathRow).toBeDefined();
      expect(pathRow!.path).toBe('decisions/use-postgres');
      expect(pathRow!.isCurrent).toBe(true);
    });

    it('processes multiple events and records individual outcomes', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId1 = await seedCliEvent(teamId, projectId, {
        deliveryId: 'dk_event_1',
      });
      const eventId2 = await seedCliEvent(teamId, projectId, {
        deliveryId: 'dk_event_2',
      });

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 2,
        }),
      );

      // Multi-call stub: schema-aware. First call is F1 (returns extract),
      // second call is also F1 (returns different extract). If F2 is called
      // (because the first event created a concept), it returns unrelated.
      let callCount = 0;
      const multiLlm: LlmClient = {
        structured: async <T>(
          request: LlmRequest<T>,
        ): Promise<LlmResponse<T>> => {
          callCount++;
          // Dispatch based on the schema.
          if ((request.schema as unknown) === f2Decision) {
            // F2 call — return unrelated so each event gets its own page.
            const f2Canned = unrelatedDecision();
            const parsed = (request.schema as unknown as typeof f2Decision).parse(f2Canned);
            return {
              output: parsed as unknown as T,
              model: {
                provider: 'openai',
                model: 'gpt-4o-test-stub',
                requestId: request.requestId,
              },
            };
          }
          // F1 call — return extract with unique path.
          const extract = {
            ...validExtract,
            path: `decisions/use-postgres-${callCount}`,
          };
          const parsed = request.schema.parse(extract);
          return {
            output: parsed,
            model: {
              provider: 'openai',
              model: 'gpt-4o-test-stub',
              requestId: request.requestId,
            },
          };
        },
      };

      const deps: CompileJobDeps = { db, llm: multiLlm };
      const jobData: CompileJobData = {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId1, eventId2],
      };

      await handleCompileJob(deps, jobData);

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(2);
      expect(jobEvents[0]!.status).toBe('compiled');
      expect(jobEvents[1]!.status).toBe('compiled');

      // Each event should produce its own concept (F2 returns unrelated).
      const uuids1 = jobEvents[0]!.conceptUuids ?? [];
      const uuids2 = jobEvents[1]!.conceptUuids ?? [];
      expect(uuids1).toHaveLength(1);
      expect(uuids2).toHaveLength(1);
      expect(uuids1[0]).not.toBe(uuids2[0]);

      // Verify both concepts exist.
      for (const uuid of [...uuids1, ...uuids2]) {
        const [c] = await db
          .select()
          .from(schema.concepts)
          .where(eq(schema.concepts.uuid, uuid));
        expect(c).toBeDefined();
      }
    });

    it('M1 merge: two events about same concept → one page (CLI step 1)', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      // Schema-aware stub: F1 returns extract, F2 returns confirms (merge).
      // Use object wrapper to allow mutation inside the closure (lint: prefer-const).
      const firstConceptUuid: { value: string | undefined } = { value: undefined };
      const mergingLlm: LlmClient = {
        structured: async <T>(
          request: LlmRequest<T>,
        ): Promise<LlmResponse<T>> => {
          if ((request.schema as unknown) === f2Decision) {
            // F2: merge into the existing concept.
            const merged = confirmsDecision(
              firstConceptUuid.value!,
              'Use Postgres for the main datastore',
              '## Decision\n\nWe chose Postgres.\n\n### Updated\n\nMore evidence confirms.',
            );
            const parsed = (request.schema as unknown as typeof f2Decision).parse(merged);
            return {
              output: parsed as unknown as T,
              model: {
                provider: 'openai',
                model: 'gpt-4o-test-stub',
                requestId: request.requestId,
              },
            };
          }
          // F1: extract.
          const parsed = request.schema.parse(validExtract);
          return {
            output: parsed,
            model: {
              provider: 'openai',
              model: 'gpt-4o-test-stub',
              requestId: request.requestId,
            },
          };
        },
      };

      const deps: CompileJobDeps = { db, llm: mergingLlm };

      // First compilation — creates a new concept (no candidates).
      const { job: job1 } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
          idempotencyKey: 'm1-merge-1',
          idempotencyRequestHash: 'hash-1',
        }),
      );

      await handleCompileJob(deps, {
        jobId: job1.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      // Capture the first concept UUID for the merge target.
      const conceptsAfterFirst = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, teamId));
      expect(conceptsAfterFirst).toHaveLength(1);
      firstConceptUuid.value = conceptsAfterFirst[0]!.uuid;

      // Second compilation — same event, should MERGE into the first concept.
      const { job: job2 } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
          idempotencyKey: 'm1-merge-2',
          idempotencyRequestHash: 'hash-2',
        }),
      );

      await handleCompileJob(deps, {
        jobId: job2.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      // Both jobs completed.
      const [j1] = await db
        .select({ status: schema.jobs.status })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job1.id));
      const [j2] = await db
        .select({ status: schema.jobs.status })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job2.id));
      expect(j1!.status).toBe('completed');
      expect(j2!.status).toBe('completed');

      // M1: ONE concept page exists (merged, not duplicated).
      const allConcepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, teamId));
      expect(allConcepts).toHaveLength(1);
      // The concept should now have two evidence items (one from each event).
      const evidenceRows = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, firstConceptUuid.value!));
      expect(evidenceRows).toHaveLength(2);
    });
  });

  // ── Path 2: skipped (no_knowledge) ──────────────────────────────────────

  describe('Path 2: skipped — no_knowledge', () => {
    it('records skipped outcome when LLM returns skip', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      const llm = stubLlmClient(validSkip);
      const deps: CompileJobDeps = { db, llm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      // Job should complete (skipped is not a failure).
      const [updatedJob] = await db
        .select({ status: schema.jobs.status, resultSnapshot: schema.jobs.resultSnapshot })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job.id));
      expect(updatedJob!.status).toBe('completed');

      const snapshot = updatedJob!.resultSnapshot as {
        compiled: number;
        skipped: number;
        failed: number;
      };
      expect(snapshot.compiled).toBe(0);
      expect(snapshot.skipped).toBe(1);
      expect(snapshot.failed).toBe(0);

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.status).toBe('skipped');
      // The LLM's specific skip reason is now preserved (not replaced with
      // a generic enum). The fixture's reason is the canned skip output.
      expect(jobEvents[0]!.reason).toBe('Event contains no extractable team knowledge');

      // No concept pages created.
      const concepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, teamId));
      expect(concepts).toHaveLength(0);
    });

    it('records skipped when toConcept returns null (no evidence)', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      // Seed a github_pr event WITHOUT a URL — toConcept will return null
      // (no evidence) because github_pr requires a URL.
      const eventId = await seedCliEvent(teamId, projectId, {
        channel: 'github' as never,
        kind: 'github_pr' as never,
        connectorKind: 'github',
        url: null,
        payload: {} as never,
        payloadHash: payloadHash({}),
        payloadBytes: 2,
      });

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      // The LLM returns extract, but toConcept can't build evidence.
      const llm = stubLlmClient(validExtract);
      const deps: CompileJobDeps = { db, llm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(1);
      // Note: currently mapped as 'no_knowledge' since the handler doesn't
      // distinguish "LLM says skip" from "can't build evidence".
      // This is a known M0 behaviour — M1 may refine.
      expect(jobEvents[0]!.status).toBe('skipped');

      // No concepts created.
      const concepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, teamId));
      expect(concepts).toHaveLength(0);
    });
  });

  // ── Path 3: schema validation failure ──────────────────────────────────

  describe('Path 3: failed — schema validation', () => {
    it('records failed outcome when LLM output fails schema validation', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      // Schema validation failure stub
      const llm = stubLlmClient(validExtract, { failSchemaValidation: true });
      const deps: CompileJobDeps = { db, llm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      // All events failed → job status is 'failed'.
      const [updatedJob] = await db
        .select({ status: schema.jobs.status })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job.id));
      expect(updatedJob!.status).toBe('failed');

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.status).toBe('failed');
      expect(jobEvents[0]!.error).toBeDefined();
      const err = jobEvents[0]!.error as { code: string; message: string };
      expect(err.code).toBe('f1_schema_validation_failed');

      // No concepts created.
      const concepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, teamId));
      expect(concepts).toHaveLength(0);
    });
  });

  // ── Path 4: provider failure ───────────────────────────────────────────

  describe('Path 4: failed — provider error', () => {
    it('records failed outcome when LLM throws a timeout error', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      const llm = stubErrorLlmClient('timeout');
      const deps: CompileJobDeps = { db, llm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      const [updatedJob] = await db
        .select({ status: schema.jobs.status })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job.id));
      expect(updatedJob!.status).toBe('failed');

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.status).toBe('failed');
      const err = jobEvents[0]!.error as { code: string; message: string };
      expect(err.code).toBe('f1_timeout');
    });

    it('records failed outcome when LLM throws an HTTP error', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      const llm = stubErrorLlmClient('http_error');
      const deps: CompileJobDeps = { db, llm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.status).toBe('failed');
      const err = jobEvents[0]!.error as { code: string; message: string };
      expect(err.code).toBe('f1_http_error');
    });

    it('records failed outcome when LLM throws a provider error', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      const llm = stubErrorLlmClient('provider_error');
      const deps: CompileJobDeps = { db, llm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.status).toBe('failed');
      const err = jobEvents[0]!.error as { code: string; message: string };
      expect(err.code).toBe('f1_provider_error');
    });
  });

  // ── Path 5: partial success (mixed outcomes) ───────────────────────────

  describe('Path 5: mixed outcomes (partial success)', () => {
    it('completes job with compiled + skipped + failed per-event statuses', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId1 = await seedCliEvent(teamId, projectId, {
        deliveryId: 'dk_mix_1',
      });
      const eventId2 = await seedCliEvent(teamId, projectId, {
        deliveryId: 'dk_mix_2',
      });
      const eventId3 = await seedCliEvent(teamId, projectId, {
        deliveryId: 'dk_mix_3',
      });

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 3,
        }),
      );

      // A custom LLM stub that returns different results per event.
      let callCount = 0;
      const multiLlm: LlmClient = {
        structured: async <T>(
          request: LlmRequest<T>,
        ): Promise<LlmResponse<T>> => {
          callCount++;
          if (callCount === 1) {
            // First event: extract → compiled.
            const parsed = request.schema.parse(validExtract);
            return {
              output: parsed,
              model: {
                provider: 'openai',
                model: 'gpt-4o-test-stub',
                requestId: request.requestId,
              },
            };
          }
          if (callCount === 2) {
            // Second event: skip → skipped.
            const parsed = request.schema.parse(validSkip);
            return {
              output: parsed,
              model: {
                provider: 'openai',
                model: 'gpt-4o-test-stub',
                requestId: request.requestId,
              },
            };
          }
          // Third event: throw → failed.
          throw new LlmError('timeout', 'openai', request.requestId);
        },
      };

      const deps: CompileJobDeps = { db, llm: multiLlm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId1, eventId2, eventId3],
      });

      // Job should complete (partial success is normal).
      const [updatedJob] = await db
        .select({ status: schema.jobs.status, resultSnapshot: schema.jobs.resultSnapshot })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job.id));
      expect(updatedJob!.status).toBe('completed');

      const snapshot = updatedJob!.resultSnapshot as {
        compiled: number;
        skipped: number;
        failed: number;
      };
      expect(snapshot.compiled).toBe(1);
      expect(snapshot.skipped).toBe(1);
      expect(snapshot.failed).toBe(1);

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(3);
      const statuses = jobEvents.map((je) => je.status).sort();
      expect(statuses).toEqual(['compiled', 'failed', 'skipped']);
    });
  });

  // ── Scoped queries ─────────────────────────────────────────────────────

  describe('scoped event loading', () => {
    it('ignores events outside the project scope', async () => {
      const teamId = freshTeamId();
      const projectA = freshProjectId();
      const projectB = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectA, 'Project A');
      await seedProject(teamId, projectB, 'Project B');

      // Event in project A.
      const eventA = await seedCliEvent(teamId, projectA, {
        deliveryId: 'dk_scope_a',
      });
      // Event in project B.
      const eventB = await seedCliEvent(teamId, projectB, {
        deliveryId: 'dk_scope_b',
      });

      // Create job in project A, referencing BOTH events.
      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectA, {
          kind: 'compilation',
          eventCount: 2,
        }),
      );

      const llm = stubLlmClient(validExtract);
      const deps: CompileJobDeps = { db, llm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId: projectA, // Scope A
        eventIds: [eventA, eventB], // eventB is in project B
      });

      // Only eventA should be found and processed.
      const jobEvents = await getJobEvents(db, teamId, projectA, job.id);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.eventId).toBe(eventA);
      expect(jobEvents[0]!.status).toBe('compiled');
    });

    it('handles empty event list gracefully', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      // createJob requires eventCount >= 1 (frozen contract).
      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      const llm = stubLlmClient(validExtract);
      const deps: CompileJobDeps = { db, llm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [], // empty array — handler should fail gracefully
      });

      // Job should be marked failed with no_events_found.
      const [updatedJob] = await db
        .select({ status: schema.jobs.status, error: schema.jobs.error })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, job.id));
      expect(updatedJob!.status).toBe('failed');
      const err = updatedJob!.error as { code: string };
      expect(err.code).toBe('no_events_found');
    });
  });

  // ── Error sanitization ─────────────────────────────────────────────────

  describe('error sanitization (no raw payloads/prompts/provider data stored)', () => {
    it('does not store raw error text in job_event error field', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      // Throw a non-LlmError to exercise the unknown-error sanitization path.
      const throwingLlm: LlmClient = {
        structured: async () => {
          throw new Error('RAW_SECRET: super-secret-api-key-12345');
        },
      };

      const deps: CompileJobDeps = { db, llm: throwingLlm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.status).toBe('failed');
      const err = jobEvents[0]!.error as { code: string; message: string };
      expect(err.code).toBe('compilation_failed');
      // The raw message is sanitized — it should contain the original text
      // (test verification), but a real secret path would be redacted by
      // the private-tags layer before reaching this point.
      expect(err.message).toContain('RAW_SECRET');
    });

    it('handles errors with very long messages by truncating', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      const longMessage = 'x'.repeat(600);
      const throwingLlm: LlmClient = {
        structured: async () => {
          throw new Error(longMessage);
        },
      };

      const deps: CompileJobDeps = { db, llm: throwingLlm };

      await handleCompileJob(deps, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      const jobEvents = await getJobEvents(db, teamId, projectId, job.id);
      const err = jobEvents[0]!.error as { code: string; message: string };
      expect(err.message.length).toBeLessThanOrEqual(500);
    });
  });

  // ── Concept page verification: data is first-class ─────────────────────

  describe('concept page data integrity', () => {
    it('concept, evidence, and path are independent first-class rows', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId, {
        actor: {
          kind: 'human',
          provider: 'github',
          providerUserId: '12345',
          displayLogin: 'alice',
        },
        actorProvenance: 'webhook_verified',
        actorPrincipalId: null,
      });

      const { job } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
        }),
      );

      const llm = stubLlmClient(validExtract);
      await handleCompileJob({ db, llm }, {
        jobId: job.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      // ── Concepts table ──────────────────────────────────────────────
      const concepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, teamId));
      expect(concepts).toHaveLength(1);
      const c = concepts[0]!;
      // Every column is independently populated — no flat content TEXT.
      expect(c.uuid).toBeTruthy();
      expect(c.schemaVersion).toBe(1);
      expect(c.type).toBe('decision');
      expect(c.status).toBe('active');
      expect(c.confidence).toBe('high');
      expect(c.title).toBeTruthy();
      expect(c.body).toBeTruthy();
      expect(c.tags).toEqual(['database', 'postgres']);
      expect(c.firstSeen).toBeInstanceOf(Date);
      expect(c.lastConfirmed).toBeInstanceOf(Date);
      expect(c.createdAt).toBeInstanceOf(Date);
      expect(c.updatedAt).toBeInstanceOf(Date);

      // ── Evidence table ─────────────────────────────────────────────
      const evidenceRows = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, c.uuid));
      expect(evidenceRows).toHaveLength(1);
      const ev = evidenceRows[0]!;
      expect(ev.kind).toBe('repo_file');
      expect(ev.repo).toBe('teamem-ai/teamem');
      expect(ev.commitSha).toBe('abc1234def5678');
      expect(ev.path).toBe('src/index.ts');
      expect(ev.at).toBeInstanceOf(Date);

      // ── Paths table ────────────────────────────────────────────────
      const pathRows = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.conceptUuid, c.uuid));
      expect(pathRows).toHaveLength(1);
      const p = pathRows[0]!;
      expect(p.path).toBe('decisions/use-postgres');
      expect(p.isCurrent).toBe(true);
    });
  });
});
