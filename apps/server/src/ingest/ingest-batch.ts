/**
 * Batch ingestion core logic (M0-ING-04).
 *
 * Processes POST /v1/events/batch requests: non-atomic per-item processing,
 * one batch compile job, plain 200 response with accepted/rejected/duplicate
 * results, and result-snapshot replay.
 *
 * Pipeline order (red line 5.3): validate → stripPrivateTags → persist → enqueue.
 *
 * Batch-level idempotency (N1): same (projectId, kind='ingest_batch', idempotencyKey)
 * + same idempotencyRequestHash → replay with stored resultSnapshot.
 * Different hash → 409 idempotency_conflict.
 *
 * Per-item idempotency: each item becomes an event with
 * deliveryId=batch.idempotencyKey + itemKey=item.itemKey, using the
 * existing idempotent insertEvent path. Replayed items return duplicate;
 * hash mismatches per-item return rejected with idempotency_conflict.
 */
import { and, eq } from 'drizzle-orm';
import {
  type IngestBatchRequest,
  type IngestBatchResponse,
  PAYLOAD_SCHEMA_VERSION,
  EVENT_ENVELOPE_VERSION,
} from '@teamem/schema';
import * as schema from '../db/schema.js';
import type { AppDb } from '../db/client.js';
import {
  insertEvent,
  IdempotencyConflictError as RepoIdempotencyConflictError,
} from '../db/repositories/events.js';
import {
  createJob,
  findJobByIdempotencyKey,
  IdempotencyConflictError as JobIdempotencyConflictError,
} from '../db/repositories/jobs.js';
import { stripPrivateTags } from '../security/private-tags.js';
import { payloadHash, payloadByteLength } from '../security/payload-hash.js';
import type { AuthContext } from '../db/repositories/api-keys.js';
import type { CompileQueue } from '../queue/boss.js';

// ── Channel constants for the public REST channel ───────────────────────────

const CHANNEL = 'cli' as const;
const KIND = 'cli_init' as const;
const CONNECTOR_KIND = 'cli' as const;
const JOB_KIND = 'ingest_batch' as const;

// ── Processed item (after redaction + hashing) ──────────────────────────────

interface ProcessedItem {
  index: number;
  itemKey: string;
  sourceExternalId: string;
  sourceUrl: string | undefined;
  actor: Record<string, unknown> | null;
  occurredAt: string | undefined;
  redactedPayload: Record<string, unknown>;
  hash: string;
  byteLen: number;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ProcessBatchDeps {
  db: AppDb;
  /** Optional compile queue — only enqueued when compile=true. */
  queue?: CompileQueue;
}

export interface ProcessBatchResult {
  response: IngestBatchResponse;
  /** true when this was a new batch; false when it was a replay. */
  created: boolean;
}

/**
 * Process a validated batch ingestion request.
 *
 * Steps:
 * 1. Redact + hash every item (so we can compute the batch-level hash).
 * 2. Check batch-level idempotency via the jobs table.
 *    - Replay → return the stored resultSnapshot (duplicate: true).
 *    - Conflict → throw JobIdempotencyConflictError (maps to 409).
 * 3. Insert each event idempotently via insertEvent; build per-item results.
 * 4. Create the batch job (always, for result-snapshot storage) and
 *    optionally enqueue for compilation. Store the full response as
 *    resultSnapshot so replays are byte-level identical.
 */
export async function processIngestBatch(
  deps: ProcessBatchDeps,
  req: IngestBatchRequest,
  teamId: string,
  auth: AuthContext,
  requestId?: string,
): Promise<ProcessBatchResult> {
  const { db, queue } = deps;
  const now = new Date();

  // ── Step 1: Redact + hash every item ──────────────────────────────────
  const processed: ProcessedItem[] = req.events.map((item, index) => {
    const redactedPayload = stripPrivateTags(item.payload) as Record<string, unknown>;
    const hash = payloadHash(redactedPayload);
    const byteLen = payloadByteLength(redactedPayload);
    return {
      index,
      itemKey: item.itemKey,
      sourceExternalId: item.source.externalId,
      sourceUrl: item.source.url,
      actor: item.actor ?? null,
      occurredAt: item.occurredAt,
      redactedPayload,
      hash,
      byteLen,
    };
  });

  // ── Step 2: Compute batch-level idempotency hash ──────────────────────
  // Hash the determinative content: array of {itemKey, externalId, url?,
  // actor?, occurredAt?, redactedPayload}.  The idempotencyKey itself is
  // NOT included — it is the lookup key, not the content.
  const eventsForHash = processed.map((pi) => ({
    k: pi.itemKey,
    e: pi.sourceExternalId,
    ...(pi.sourceUrl !== undefined ? { u: pi.sourceUrl } : {}),
    ...(pi.actor !== null ? { a: pi.actor } : {}),
    ...(pi.occurredAt !== undefined ? { t: pi.occurredAt } : {}),
    p: pi.redactedPayload,
  }));
  const batchHash = payloadHash(eventsForHash);

  // ── Step 3: Check batch-level idempotency (pre-processing fast path) ──
  const existingJob = await findJobByIdempotencyKey(
    db,
    teamId,
    req.projectId,
    JOB_KIND,
    req.idempotencyKey,
  );

  if (existingJob) {
    if (
      existingJob.idempotencyRequestHash === batchHash &&
      existingJob.resultSnapshot != null
    ) {
      // Byte-level replay: return the ORIGINAL result snapshot.
      const snapshot = existingJob.resultSnapshot as IngestBatchResponse;
      return {
        response: { ...snapshot, duplicate: true },
        created: false,
      };
    }

    // Hash mismatch → 409 conflict.
    throw new JobIdempotencyConflictError(existingJob.id);
  }

  // ── Step 4: Process each item — idempotent event insert ───────────────
  const results: IngestBatchResponse['results'] = [];
  const acceptedEventIds: string[] = [];

  for (const pi of processed) {
    try {
      const eventResult = await insertEvent(db, {
        teamId,
        projectId: req.projectId,
        channel: CHANNEL,
        kind: KIND,
        connectorKind: CONNECTOR_KIND,
        deliveryId: req.idempotencyKey, // batch key is the delivery scope
        itemKey: pi.itemKey,
        externalId: pi.sourceExternalId,
        url: pi.sourceUrl ?? null,
        actor: pi.actor,
        actorProvenance: pi.actor ? 'client_claimed' : 'unknown',
        actorPrincipalId: null,
        occurredAt: pi.occurredAt ? new Date(pi.occurredAt) : now,
        occurredAtProvenance: pi.occurredAt ? 'client' : 'server',
        ingestedByCredentialId: auth.credentialId,
        ingestedByPrincipalId: auth.principal?.id ?? null,
        payload: pi.redactedPayload,
        payloadHash: pi.hash,
        payloadBytes: pi.byteLen,
        payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
        envelopeVersion: EVENT_ENVELOPE_VERSION,
      });

      results.push({
        index: pi.index,
        status: eventResult.status === 'duplicate' ? 'duplicate' : 'accepted',
        eventId: eventResult.eventId,
      });

      if (eventResult.status === 'inserted') {
        acceptedEventIds.push(eventResult.eventId);
      }
    } catch (err) {
      if (err instanceof RepoIdempotencyConflictError) {
        // Per-item idempotency conflict — same identity, different payload.
        results.push({
          index: pi.index,
          status: 'rejected',
          error: { code: 'idempotency_conflict', message: err.message },
        });
      } else {
        // Unexpected error — log but don't leak internals to the response.
        console.error(
          JSON.stringify({
            event: 'batch_item_insert_failed',
            index: pi.index,
            itemKey: pi.itemKey,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        results.push({
          index: pi.index,
          status: 'rejected',
          error: { code: 'internal', message: 'Event insert failed' },
        });
      }
    }
  }

  // ── Step 5: Create batch job (always — stores result snapshot for replay) ─
  let batchJobId: string | null = null;

  try {
    const jobResult = await createJob(db, {
      teamId,
      projectId: req.projectId,
      kind: JOB_KIND,
      initiatedByKind: 'credential',
      initiatedByCredentialId: auth.credentialId,
      initiatedByPrincipalId: auth.principal?.id ?? null,
      idempotencyKey: req.idempotencyKey,
      idempotencyRequestHash: batchHash,
      eventCount: acceptedEventIds.length,
    });

    batchJobId = jobResult.job.id;
    const created = jobResult.created;

    // Build the full response.
    const response: IngestBatchResponse = {
      requestId: requestId ?? '',
      batchJobId: req.options.compile ? batchJobId : null,
      duplicate: false,
      results,
    };

    if (created) {
      // Persist the result snapshot so idempotent replays return the
      // exact same per-item results (byte-level identical).
      await db
        .update(schema.jobs)
        .set({ resultSnapshot: response as unknown as Record<string, unknown> })
        .where(
          and(
            eq(schema.jobs.id, batchJobId),
            eq(schema.jobs.teamId, teamId),
            eq(schema.jobs.projectId, req.projectId),
          ),
        );
    }

    // Enqueue for compilation only when compile=true and a queue is available.
    if (req.options.compile && queue && created) {
      try {
        await queue.send({ jobId: batchJobId });
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'batch_compile_enqueue_failed',
            jobId: batchJobId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    return { response, created: true };
  } catch (err) {
    if (err instanceof JobIdempotencyConflictError) {
      // Race: another caller created the job between our pre-check and insert.
      // Re-query and return the existing snapshot.
      const raced = await findJobByIdempotencyKey(
        db,
        teamId,
        req.projectId,
        JOB_KIND,
        req.idempotencyKey,
      );
      if (raced?.resultSnapshot) {
        const snapshot = raced.resultSnapshot as IngestBatchResponse;
        return { response: { ...snapshot, duplicate: true }, created: false };
      }
      // No snapshot — use the existing job ID.
      batchJobId = err.existingJobId;
    } else {
      // Job creation failed for a non-idempotency reason. The events ARE
      // persisted — return per-item results without a batch job.
      console.error(
        JSON.stringify({
          event: 'batch_job_create_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // ── Fallback: events persisted but job creation failed ────────────────
  const response: IngestBatchResponse = {
    requestId: requestId ?? '',
    batchJobId,
    duplicate: false,
    results,
  };

  return { response, created: true };
}
