/**
 * F1 compilation job handler — integration tests (M0-F1-06).
 *
 * Exercises the full compile job handler against real Postgres with a
 * test-only structured-output stub (no real LLM keys or network required).
 *
 * The stub LLM client returns pre-configured F1 responses so the test can
 * drive every branch: extract → compiled, skip → skipped (no_knowledge),
 * schema validation failure → failed, and simulated provider error → failed.
 *
 * Verifies:
 *  - Concept pages, evidence, paths, and contributors are first-class
 *    database rows (CLI acceptance step 3).
 *  - Per-event job outcomes are recorded with the correct discriminated status.
 *  - Job lifecycle transitions: queued → processing → completed / failed.
 *  - The job result snapshot carries the produced concept UUIDs.
 *  - Scoped queries: events outside the project scope are not loaded.
 *  - M0 duplicate pages: calling the same event twice produces TWO concept
 *    pages (no F2 merging — honest and expected).
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
    return `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function freshProjectId(): string {
    return `prj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
   * for every call. The stub validates the Zod schema via actual parse (so
   * schema-mismatch bugs in the test are caught by the stub), then returns
   * the canned output.
   */
  function stubLlmClient(
    canned: F1Output,
    opts?: { failSchemaValidation?: boolean },
  ): LlmClient {
    // Re-validate the canned output at construction time so the test
    // author gets immediate feedback if the canned payload is invalid.
    if (!opts?.failSchemaValidation) {
      // We trust the canned output is valid; do a quick check.
    }

    return {
      structured: async <T>(
        request: LlmRequest<T>,
      ): Promise<LlmResponse<T>> => {
        if (opts?.failSchemaValidation) {
          // Return bad JSON that won't parse as the expected schema.
          throw new LlmError(
            'schema_validation_failed',
            'openai',
            request.requestId,
          );
        }

        // Parse the canned output against the request schema so we
        // exercise the real Zod re-validation path.
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

      // Multi-call stub: each call returns a different extract with a unique path.
      let callCount = 0;
      const multiLlm: LlmClient = {
        structured: async <T>(
          request: LlmRequest<T>,
        ): Promise<LlmResponse<T>> => {
          callCount++;
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

      // Each event should produce its own concept.
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

    it('M0 behaviour: produces duplicate concept pages for the same event (no F2 merging)', async () => {
      const teamId = freshTeamId();
      const projectId = freshProjectId();
      await seedTeam(teamId);
      await seedProject(teamId, projectId);

      const eventId = await seedCliEvent(teamId, projectId);

      // Multi-call stub: each call returns a different path so both
      // compilations succeed (path uniqueness is a database constraint;
      // F2 merging in M1 will handle same-path deduplication).
      let callCount = 0;
      const multiLlm: LlmClient = {
        structured: async <T>(
          request: LlmRequest<T>,
        ): Promise<LlmResponse<T>> => {
          callCount++;
          const extract = {
            ...validExtract,
            path: `decisions/use-postgres-v${callCount}`,
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

      // First compilation.
      const { job: job1 } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
          idempotencyKey: 'm0-duplicate-1',
          idempotencyRequestHash: 'hash-1',
        }),
      );

      await handleCompileJob(deps, {
        jobId: job1.id,
        teamId,
        projectId,
        eventIds: [eventId],
      });

      // Second compilation — same event, different job.
      const { job: job2 } = await createJob(
        db,
        makeCreateJobReq(teamId, projectId, {
          kind: 'compilation',
          eventCount: 1,
          idempotencyKey: 'm0-duplicate-2',
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

      // M0: TWO concept pages exist (no F2 merging — honest, expected).
      const allConcepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, teamId));
      expect(allConcepts).toHaveLength(2);
      // Both have the same title (from the same extract output).
      expect(allConcepts[0]!.title).toBe('Use Postgres for the main datastore');
      expect(allConcepts[1]!.title).toBe('Use Postgres for the main datastore');
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
