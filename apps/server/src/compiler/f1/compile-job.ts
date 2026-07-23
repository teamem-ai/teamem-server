/**
 * Full-loop compilation job handler (M1-F2-05).
 *
 * This is the pg-boss worker handler for `kind = 'compilation'` jobs. It
 * runs the complete F1 → F2 pipeline:
 *
 *  1. Loads scoped events by their IDs (team + project scope, red line 5.5).
 *  2. Calls F1 (LLM structured extraction) for each event.
 *  3. Generates embedding from F1 title + body (when vector capability).
 *  4. Calls F2 candidate recall (vector or FTS) to find potential merge targets.
 *  5. Calls F2 merge-decider (strong-model LLM) to decide: confirms, extends,
 *     contradicts, or unrelated.
 *  6. Transactionally persists: merges into existing concept (updateConcept)
 *     or creates a new concept (createConcept).
 *  7. Records per-event outcomes: compiled, skipped (no_knowledge), or failed.
 *  8. Completes the job with the set of concept page UUIDs produced.
 *
 * M1 behaviour: F2 resolves duplicates — two events about the same concept
 * merge into ONE page. F1 skip/noise events produce no pages.
 *
 * Error hygiene (§5.3, §6.4):
 *  - LLM errors are recorded as sanitized {code, message} — no API keys,
 *    raw payloads, prompts, or provider responses are stored.
 *  - Concept persistence failures roll back the individual event (no partial
 *    concept rows) and the event is marked failed in the job.
 *  - The job itself transitions to 'failed' only when ALL events fail; partial
 *    success is a normal 'completed' job with mixed per-event statuses.
 *
 * The handler depends on:
 *  - AppDb (scoped queries + transaction writes)
 *  - LlmClient (structured F1 extraction + F2 merge decision)
 *  - EmbeddingClient (generating embeddings for F1 concepts)
 *  - The frozen @teamem/schema f1Output + f2Decision contracts
 *  - The jobs repository (lifecycle + per-event outcomes)
 *  - The concepts-write repository (createConcept + updateConcept)
 *  - The events repository (scoped event loading)
 *  - F1 prompt builder + toConcept mapper + output schema (local F1 modules)
 *  - F2 candidate recall + merge-decider + decision schema (local F2 modules)
 */
import type { AppDb } from '../../db/client.js';
import type { LlmClient, LlmError } from '../../llm/types.js';
import type { EmbeddingClient } from '../../llm/embedding/port.js';
import { f1Output } from './output.js';
import { buildF1Prompt } from './prompt.js';
import { prefilterNoise } from './skip-filter.js';
import { toConcept } from './to-concept.js';
import { getEventsByIds } from '../../db/repositories/events.js';
import {
  createConcept,
  updateConcept,
  type CreateConceptInput,
  type UpdateConceptInput,
} from '../../db/repositories/concepts-write.js';
import {
  updateJobStatus,
  upsertJobEvent,
} from '../../db/repositories/jobs.js';
import { projectScope } from '../../auth/scope.js';
import { resolveSemanticCapability } from '../../llm/embedding/capability.js';
import { recallCandidates } from '../f2/candidates.js';
import {
  decideMerge,
  type CandidateConceptSummary,
  type NewConceptInput,
} from '../f2/merge-decider.js';
import type { F2Decision } from '../f2/decision.js';
import { eq, and, inArray } from 'drizzle-orm';
import * as schema from '../../db/schema.js';

// ── Handler dependencies ────────────────────────────────────────────────────

/**
 * Injectable dependencies for the compile-job handler.
 *
 * `db` and `llm` are the only resources the handler owns — every other
 * dependency is a pure function imported at module scope.
 *
 * `embeddingClient` is optional — when absent (Claude provider, no
 * embedding-capable provider configured), the handler leaves the embedding
 * column NULL and the system falls back to full-text search (§5.5).
 */
export interface CompileJobDeps {
  readonly db: AppDb;
  readonly llm: LlmClient;
  readonly embeddingClient?: EmbeddingClient | null;
}

// ── Job data shape ─────────────────────────────────────────────────────────

/**
 * The shape of `job.data` as received from pg-boss. This is the payload
 * enqueued alongside the createJob() row.
 */
export interface CompileJobData {
  /** The teamem job UUID (matches jobs.id in the database). */
  readonly jobId: string;
  /** Tenant scope. */
  readonly teamId: string;
  /** Project scope. */
  readonly projectId: string;
  /** Event IDs to compile (evt_...). */
  readonly eventIds: readonly string[];
}

// ── Per-event result helpers ───────────────────────────────────────────────

/**
 * Record a single compiled event outcome: the concept page was successfully
 * persisted.
 */
async function recordCompiled(
  db: AppDb,
  teamId: string,
  projectId: string,
  jobId: string,
  eventId: string,
  conceptUuids: string[],
): Promise<void> {
  await upsertJobEvent(db, {
    teamId,
    projectId,
    jobId,
    eventId,
    status: 'compiled',
    conceptUuids,
  });
}

/**
 * Record a skipped event outcome: the LLM returned `skip`, the prefilter
 * caught noise, or the mapper could not construct evidence.
 *
 * The `reason` string is stored as-is in the job_event row. Callers
 * should pass the specific human-readable reason from the LLM or prefilter
 * rather than a generic enum value (N8: reason is an open text registry).
 */
async function recordSkipped(
  db: AppDb,
  teamId: string,
  projectId: string,
  jobId: string,
  eventId: string,
  reason: string,
): Promise<void> {
  await upsertJobEvent(db, {
    teamId,
    projectId,
    jobId,
    eventId,
    status: 'skipped',
    reason,
  });
}

/**
 * Record a failed event outcome: the LLM call failed, schema validation
 * failed, or concept persistence failed.
 *
 * `error` must be sanitized — no raw payloads, prompts, or provider responses
 * (N3/N7).
 */
async function recordFailed(
  db: AppDb,
  teamId: string,
  projectId: string,
  jobId: string,
  eventId: string,
  code: string,
  message: string,
): Promise<void> {
  await upsertJobEvent(db, {
    teamId,
    projectId,
    jobId,
    eventId,
    status: 'failed',
    error: { code, message },
  });
}

// ── Error sanitization ──────────────────────────────────────────────────────

/**
 * Map an {@link LlmError} to a sanitized {code, message} suitable for
 * job_event storage. Never retains the raw error cause, API keys, or
 * provider response bodies (§5.3/§6.4).
 */
function sanitizeLlmError(err: LlmError): { code: string; message: string } {
  return {
    code: `f1_${err.kind}`,
    message: err.message,
  };
}

/**
 * Map an unknown error to a sanitized {code, message}. The original error
 * text is redacted — only the kind is preserved.
 */
function sanitizeUnknownError(err: unknown): { code: string; message: string } {
  const message =
    err instanceof Error ? err.message : 'Unknown compilation error';
  return {
    code: 'compilation_failed',
    // Truncate to prevent unbounded error text in the database.
    message: message.length > 500 ? message.slice(0, 497) + '...' : message,
  };
}

// ── F2 candidate enrichment ─────────────────────────────────────────────────

/**
 * Enrich F2 candidate recall results with full body text and evidence
 * summaries for the merge-decider prompt.
 *
 * The recall step returns lightweight results (UUID, title, snippet). The
 * merge-decider needs the full body and evidence summaries to make an
 * informed decision. This helper loads them from the database.
 *
 * Returns candidates in the same order as the input UUIDs; candidates whose
 * concept row could not be found are silently dropped (the recall layer
 * should never return orphaned UUIDs, but we filter defensively).
 */
async function enrichF2Candidates(
  db: AppDb,
  teamId: string,
  projectId: string,
  candidateUuids: string[],
): Promise<CandidateConceptSummary[]> {
  if (candidateUuids.length === 0) return [];

  // Load concept rows.
  const conceptRows = await db
    .select({
      uuid: schema.concepts.uuid,
      type: schema.concepts.type,
      status: schema.concepts.status,
      title: schema.concepts.title,
      body: schema.concepts.body,
      tags: schema.concepts.tags,
    })
    .from(schema.concepts)
    .where(
      and(
        eq(schema.concepts.teamId, teamId),
        eq(schema.concepts.projectId, projectId),
        inArray(schema.concepts.uuid, candidateUuids),
      ),
    );

  // Load current paths for these concepts.
  const pathRows = await db
    .select({
      conceptUuid: schema.conceptPaths.conceptUuid,
      path: schema.conceptPaths.path,
    })
    .from(schema.conceptPaths)
    .where(
      and(
        eq(schema.conceptPaths.teamId, teamId),
        eq(schema.conceptPaths.projectId, projectId),
        eq(schema.conceptPaths.isCurrent, true),
        inArray(schema.conceptPaths.conceptUuid, candidateUuids),
      ),
    );

  const pathMap = new Map(pathRows.map((r) => [r.conceptUuid, r.path]));

  // Load evidence rows for these concepts.
  const evidenceRows = await db
    .select({
      conceptUuid: schema.conceptEvidence.conceptUuid,
      kind: schema.conceptEvidence.kind,
      ref: schema.conceptEvidence.ref,
      repo: schema.conceptEvidence.repo,
      commitSha: schema.conceptEvidence.commitSha,
      path: schema.conceptEvidence.path,
    })
    .from(schema.conceptEvidence)
    .where(
      and(
        eq(schema.conceptEvidence.teamId, teamId),
        eq(schema.conceptEvidence.projectId, projectId),
        inArray(schema.conceptEvidence.conceptUuid, candidateUuids),
      ),
    );

  // Group evidence by concept UUID.
  const evidenceMap = new Map<string, string[]>();
  for (const ev of evidenceRows) {
    const summaries = evidenceMap.get(ev.conceptUuid) ?? [];
    let summary: string;
    if (ev.kind === 'repo_file') {
      summary = `repo_file: ${ev.repo ?? '?'}@${ev.commitSha ?? '?'}/${ev.path ?? '?'}`;
    } else {
      summary = `${ev.kind}: ${ev.ref ?? '(no ref)'}`;
    }
    summaries.push(summary);
    evidenceMap.set(ev.conceptUuid, summaries);
  }

  // Preserve recall order (important: the merge-decider prompt lists
  // candidates in the order they were recalled — more relevant first).
  const conceptMap = new Map(conceptRows.map((c) => [c.uuid, c]));

  const results: CandidateConceptSummary[] = [];
  for (const uuid of candidateUuids) {
    const c = conceptMap.get(uuid);
    if (!c) continue; // Defensive: skip orphaned UUIDs.
    results.push({
      uuid: c.uuid,
      type: c.type,
      status: c.status,
      title: c.title,
      body: c.body,
      path: pathMap.get(c.uuid) ?? '',
      tags: c.tags,
      evidenceSummary: evidenceMap.get(c.uuid) ?? [],
    });
  }

  return results;
}

// ── F2 merge execution ──────────────────────────────────────────────────────

/**
 * Execute the F2 merge decision against the database.
 *
 * For `unrelated`: creates a new concept page via {@link createConcept}.
 * For `confirms`, `extends`, `contradicts`: updates the existing concept
 * via {@link updateConcept} — title, body, status, tags, evidence, and
 * contributors are merged; last_confirmed is only refreshed for `confirms`.
 *
 * @returns The concept UUID that was created or updated.
 */
async function executeMergeDecision(
  db: AppDb,
  teamId: string,
  projectId: string,
  decision: F2Decision,
  conceptInput: CreateConceptInput,
  newConceptUuid: string,
  embedding: number[] | undefined | null,
): Promise<string> {
  if (decision.relationship === 'unrelated') {
    // Create a new concept page.
    const persisted = await createConcept(db, {
      ...conceptInput,
      embedding: embedding ?? null,
    });
    return persisted.uuid;
  }

  // Merge into existing concept.
  // Build the update payload from the F2 decision + server-owned facts.
  const now = new Date();
  const updateInput: UpdateConceptInput = {
    teamId,
    projectId,
    conceptUuid: decision.targetConceptId,
    title: decision.mergedTitle,
    body: decision.mergedBody,
    status: decision.resultStatus,
    confidence: conceptInput.confidence,
    tags: [...new Set([...(conceptInput.tags ?? []), ...(decision.mergedTitle ? [] : [])])],
    lastConfirmed:
      decision.relationship === 'confirms' ? now : undefined,
    newEvidence: conceptInput.evidence,
    newContributors: conceptInput.contributors,
    embedding: embedding ?? undefined,
  };

  await updateConcept(db, updateInput);
  return decision.targetConceptId;
}

// ── Main handler ────────────────────────────────────────────────────────────

/**
 * Handle a compilation job delivered by pg-boss.
 *
 * This is the function registered as a {@link CompileJobHandler} in the
 * queue layer. It runs the full F1 → F2 pipeline:
 *
 *  1. Parses the job data.
 *  2. Loads scoped events.
 *  3. Transitions the job to `processing`.
 *  4. For each event:
 *     a. Prefilter noise (deterministic skip check).
 *     b. F1 LLM structured extraction (or skip).
 *     c. Map F1 output → concept aggregate + evidence.
 *     d. Generate embedding from title + body.
 *     e. F2 candidate recall (vector or FTS).
 *     f. F2 merge-decider (strong-model LLM).
 *     g. Execute merge: update existing or create new concept.
 *     h. Record per-event outcome.
 *  5. Transitions the job to `completed` or `failed`.
 *
 * Panics (throws) on unrecoverable errors: missing job data, no events found,
 * or database failures during status transitions. pg-boss will retry per the
 * queue policy.
 *
 * @throws on unrecoverable failures that should trigger a pg-boss retry.
 */
export async function handleCompileJob(
  deps: CompileJobDeps,
  jobData: CompileJobData,
): Promise<void> {
  const { db, llm } = deps;
  const { jobId, teamId, projectId, eventIds } = jobData;

  // Resolve semantic capability from the (optional) embedding client.
  const capability = resolveSemanticCapability(deps.embeddingClient ?? null);

  // ── 1. Load scoped events ─────────────────────────────────────────────
  const events = await getEventsByIds(db, teamId, projectId, eventIds);

  if (events.length === 0) {
    // No events found in scope — this is an unrecoverable state for this job.
    // Mark the job as failed so it doesn't endlessly retry.
    await updateJobStatus(db, teamId, projectId, jobId, 'failed', {
      error: {
        code: 'no_events_found',
        message: 'No events found for the given scope and IDs',
      },
    });
    return;
  }

  // ── 2. Transition to processing ──────────────────────────────────────
  await updateJobStatus(db, teamId, projectId, jobId, 'processing');

  // ── 3. Process each event ────────────────────────────────────────────
  const allConceptUuids: string[] = [];
  let compiledCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const event of events) {
    try {
      // 3a. Run deterministic noise checks before calling the LLM.
      const prefilterResult = prefilterNoise(
        event.channel,
        event.kind,
        event.payload as Record<string, unknown>,
      );

      if (prefilterResult) {
        await recordSkipped(
          db,
          teamId,
          projectId,
          jobId,
          event.id,
          prefilterResult.reason,
        );
        skippedCount++;
        continue;
      }

      // 3b. Build the F1 prompt from the event's source facts + redacted payload.
      const { system, user } = buildF1Prompt({
        channel: event.channel,
        kind: event.kind,
        externalId: event.externalId,
        payload: event.payload as Record<string, unknown>,
      });

      // 3c. Call the LLM with provider-native structured output.
      const response = await llm.structured({
        schema: f1Output,
        systemPrompt: system,
        userPrompt: user,
        requestId: `${jobId}:${event.id}`,
      });

      // 3d. Check the LLM's decision: extract or skip.
      if (response.output.action === 'skip') {
        await recordSkipped(
          db,
          teamId,
          projectId,
          jobId,
          event.id,
          response.output.reason,
        );
        skippedCount++;
        continue;
      }

      // 3e. Map the F1 extract output to a concept page aggregate.
      const conceptResult = toConcept({
        f1Output: response.output,
        channel: event.channel,
        kind: event.kind,
        externalId: event.externalId,
        url: event.url,
        occurredAt: event.occurredAt,
        eventId: event.id,
        actorProvenance: event.actorProvenance,
        actorPrincipalId: event.actorPrincipalId,
        ingestedByPrincipalId: event.ingestedByPrincipalId,
        payload: event.payload as Record<string, unknown>,
        teamId: event.teamId,
        projectId: event.projectId,
      });

      if (!conceptResult) {
        await recordSkipped(
          db,
          teamId,
          projectId,
          jobId,
          event.id,
          'no_knowledge',
        );
        skippedCount++;
        continue;
      }

      // 3f. Generate embedding from title + body when vector capability is
      //     available. Embedding failure → compilation failure.
      let embedding: number[] | undefined;
      if (deps.embeddingClient) {
        try {
          const embeddingText = `${conceptResult.conceptInput.title}\n\n${conceptResult.conceptInput.body}`;
          const vectors = await deps.embeddingClient.generate([embeddingText]);
          embedding = vectors[0];
          if (!embedding || embedding.length === 0) {
            throw new Error('Embedding API returned an empty result');
          }
        } catch (embeddingErr: unknown) {
          const message =
            embeddingErr instanceof Error
              ? embeddingErr.message
              : 'Embedding generation failed';
          throw new Error(`Embedding generation failed: ${message}`);
        }
      }

      // 3g. F2 candidate recall — find potential merge targets.
      const scope = projectScope(teamId, projectId);
      const recallResult = await recallCandidates(
        {
          db,
          embeddingClient: deps.embeddingClient ?? null,
          capability,
        },
        {
          scope,
          newConcept: {
            title: conceptResult.conceptInput.title,
            body: conceptResult.conceptInput.body,
          },
          limit: 5,
        },
      );

      const candidateUuids = recallResult.map((r) => r.uuid);

      // 3h. F2 merge decision.
      let conceptUuid: string;

      if (candidateUuids.length === 0) {
        // No existing candidates — this is definitely a new concept.
        // Skip the F2 LLM call and create directly.
        const persisted = await createConcept(db, {
          ...conceptResult.conceptInput,
          embedding: embedding ?? null,
        });
        conceptUuid = persisted.uuid;
      } else {
        // Enrich candidates with full body + evidence for the merge-decider.
        const enrichedCandidates = await enrichF2Candidates(
          db,
          teamId,
          projectId,
          candidateUuids,
        );

        // Build the F2 NewConceptInput from F1 output + event context.
        const newConceptInput: NewConceptInput = {
          type: conceptResult.conceptInput.type,
          title: conceptResult.conceptInput.title,
          body: conceptResult.conceptInput.body,
          path: conceptResult.conceptInput.path,
          tags: conceptResult.conceptInput.tags ?? [],
          confidence: conceptResult.conceptInput.confidence,
          channel: event.channel,
          kind: event.kind,
          externalId: event.externalId,
        };

        // Call the F2 merge-decider with provider-native structured output.
        const decision = await decideMerge(
          { llm },
          newConceptInput,
          enrichedCandidates,
          `${jobId}:${event.id}:f2`,
        );

        // Execute the merge decision: update existing or create new.
        conceptUuid = await executeMergeDecision(
          db,
          teamId,
          projectId,
          decision,
          conceptResult.conceptInput,
          conceptResult.conceptUuid,
          embedding,
        );
      }

      // 3i. Record the compiled outcome.
      await recordCompiled(db, teamId, projectId, jobId, event.id, [
        conceptUuid,
      ]);
      allConceptUuids.push(conceptUuid);
      compiledCount++;
    } catch (err: unknown) {
      // Sanitize the error before storing (red line 5.3: no raw content).
      const sanitized =
        err instanceof Error && err.name === 'LlmError'
          ? sanitizeLlmError(err as LlmError)
          : sanitizeUnknownError(err);

      await recordFailed(
        db,
        teamId,
        projectId,
        jobId,
        event.id,
        sanitized.code,
        sanitized.message,
      );
      failedCount++;
    }
  }

  // ── 4. Complete the job ──────────────────────────────────────────────
  if (compiledCount === 0 && skippedCount === 0 && failedCount > 0) {
    await updateJobStatus(db, teamId, projectId, jobId, 'failed', {
      error: {
        code: 'all_events_failed',
        message: `All ${failedCount} event(s) failed compilation`,
      },
      resultSnapshot: {
        conceptIds: allConceptUuids,
        compiled: compiledCount,
        skipped: skippedCount,
        failed: failedCount,
      },
    });
  } else {
    await updateJobStatus(db, teamId, projectId, jobId, 'completed', {
      resultSnapshot: {
        conceptIds: allConceptUuids,
        compiled: compiledCount,
        skipped: skippedCount,
        failed: failedCount,
      },
    });
  }
}
