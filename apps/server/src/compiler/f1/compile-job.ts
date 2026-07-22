/**
 * F1 compilation job handler (M0-F1-06).
 *
 * This is the pg-boss worker handler for `kind = 'compilation'` jobs. It:
 *  1. Loads scoped events by their IDs (team + project scope, red line 5.5).
 *  2. Calls F1 (LLM structured extraction) for each event.
 *  3. Transactionally persists concept page aggregates for `extract` results.
 *  4. Records per-event outcomes: compiled, skipped (no_knowledge), or failed.
 *  5. Completes the job with the set of concept page UUIDs produced.
 *
 * M0 behaviour: produces a new concept page for every extract result with NO
 * F2 merging (duplicate pages are honest and expected at this stage).
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
 *  - LlmClient (structured F1 extraction)
 *  - The frozen @teamem/schema f1Output contract
 *  - The jobs repository (lifecycle + per-event outcomes)
 *  - The concepts-write repository (transactional concept persistence)
 *  - The events repository (scoped event loading)
 *  - F1 prompt builder + toConcept mapper + output schema (local F1 modules)
 */
import type { AppDb } from '../../db/client.js';
import type { LlmClient, LlmError } from '../../llm/types.js';
import type { EmbeddingClient } from '../../llm/embedding/port.js';
import { f1Output } from './output.js';
import { buildF1Prompt } from './prompt.js';
import { prefilterNoise } from './skip-filter.js';
import { toConcept } from './to-concept.js';
import { getEventsByIds } from '../../db/repositories/events.js';
import { createConcept } from '../../db/repositories/concepts-write.js';
import {
  updateJobStatus,
  upsertJobEvent,
} from '../../db/repositories/jobs.js';

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

// ── Main handler ────────────────────────────────────────────────────────────

/**
 * Handle a compilation job delivered by pg-boss.
 *
 * This is the function registered as a {@link CompileJobHandler} in the
 * queue layer. It:
 *  1. Parses the job data.
 *  2. Loads scoped events.
 *  3. Transitions the job to `processing`.
 *  4. For each event: calls F1, persists concept if extracted, records outcome.
 *  5. Transitions the job to `completed` (even with partial failures — mixed
 *     per-event statuses are normal) or `failed` when ALL events fail.
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
      //     Obvious noise (meaningless commits, dependabot bumps, etc.)
      //     is skipped immediately without consuming LLM tokens.
      const prefilterResult = prefilterNoise(
        event.channel,
        event.kind,
        event.payload as Record<string, unknown>,
      );

      if (prefilterResult) {
        // Deterministic skip — record with the specific reason.
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
        // Pass the LLM's specific reason through to storage.
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

      // 3d. Map the F1 extract output to a concept page aggregate.
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
        // toConcept returns null when evidence cannot be constructed
        // (missing URL, missing repo_file fields, unknown source kind, etc.).
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

      // 3e. Generate embedding from title + body when vector capability is
      //     available.  Embedding generation failure is a compilation failure
      //     — the entire concept write is rolled back (no partial data).
      let embedding: number[] | undefined;
      if (deps.embeddingClient) {
        try {
          const embeddingText = `${conceptResult.conceptInput.title}\n\n${conceptResult.conceptInput.body}`;
          const vectors = await deps.embeddingClient.generate([embeddingText]);
          embedding = vectors[0];
          // The EmbeddingClient contract guarantees equal-length output,
          // but a misbehaving provider could return [].  Guard against
          // silently persisting NULL when embedding generation produced
          // nothing — that would violate "embedding failure → compilation
          // failure" (§5.5: never pretend vector search succeeded).
          if (!embedding || embedding.length === 0) {
            throw new Error(
              'Embedding API returned an empty result',
            );
          }
        } catch (embeddingErr: unknown) {
          // Embedding generation failure → compilation failure.
          // Re-throw so the outer catch records the per-event failure
          // and the concept write is not attempted (no partial data).
          const message =
            embeddingErr instanceof Error
              ? embeddingErr.message
              : 'Embedding generation failed';
          throw new Error(`Embedding generation failed: ${message}`);
        }
      }

      // 3f. Transactionally persist the concept page aggregate.
      //     createConcept generates its own UUID via defaultRandom(); the
      //     UUID from toConcept is intentionally replaced by the DB-generated
      //     one — the handler tracks the actual persisted UUID.
      const persisted = await createConcept(db, {
        ...conceptResult.conceptInput,
        embedding: embedding ?? null,
      });

      // 3g. Record the compiled outcome using the database-generated UUID.
      await recordCompiled(db, teamId, projectId, jobId, event.id, [
        persisted.uuid,
      ]);
      allConceptUuids.push(persisted.uuid);
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
  // Partial success is normal: mixed per-event statuses are expected.
  // Only transition to 'failed' when ALL events failed (nothing compiled).
  if (compiledCount === 0 && skippedCount === 0 && failedCount > 0) {
    // Every event failed — the job itself failed.
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
    // At least one event compiled or was honestly skipped.
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
