/**
 * Single-event ingestion pipeline (M0-ING-02).
 *
 * Encapsulates the full ingest-one use case:
 *   1. Derive CLI channel/delivery/item facts from the request
 *   2. Mark actor as `client_claimed` (N2: client-supplied actor is
 *      recorded as a claim, never verified)
 *   3. Derive ingested-by from the credential/principal (server-derived,
 *      never client-supplied — red line 5.4)
 *   4. Strip <private> tags from the payload (red line 5.3)
 *   5. Compute payload hash over canonical JSON of the REDACTED content
 *   6. Insert idempotently — replay of the same identity+hash returns
 *      the original eventId; different hash → conflict
 *   7. Optionally create a compile job and enqueue it (only when
 *      compile=true; replay never enqueues again)
 *
 * The pipeline order is non-negotiable: validate → strip → persist → enqueue
 * (red line 5.3). Every business query carries team_id (red line 5.5).
 */
import {
  type IngestEventRequest,
  PAYLOAD_SCHEMA_VERSION,
  EVENT_ENVELOPE_VERSION,
} from '@teamem/schema';
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
import type { CompileQueue } from '../queue/boss.js';

// ── Channel / connector constants for the public REST (CLI) channel ─────────

const CHANNEL = 'cli' as const;
const KIND = 'cli_init' as const;
const CONNECTOR_KIND = 'cli' as const;

// ── Dependency injection ────────────────────────────────────────────────────

export interface IngestOneDeps {
  /** Database handle — must be connected to a real Postgres instance. */
  db: AppDb;
  /**
   * Optional compile queue. When absent, compile=true jobs are created
   * (persisted to the jobs table) but not enqueued in pg-boss — useful for
   * testing without a running pg-boss instance.
   */
  queue?: CompileQueue;
}

// ── Auth context ────────────────────────────────────────────────────────────

export interface IngestOneAuth {
  /** Tenant identity (red line 5.5: every business query carries team_id). */
  teamId: string;
  /** Project scope. */
  projectId: string;
  /** Credential that submitted this event (server-derived, never client-supplied). */
  credentialId: string;
  /** Resolved principal id, or null when unresolved. */
  principalId: string | null;
}

// ── Result ──────────────────────────────────────────────────────────────────

export interface IngestOneResult {
  /** The event id (new on insert, original on duplicate). */
  eventId: string;
  /** Whether the event was newly inserted or a duplicate replay. */
  status: 'inserted' | 'duplicate';
  /**
   * The compile job id, or null when compile=false or (on duplicate) the
   * original job has been garbage-collected.
   */
  jobId: string | null;
}

// ── Error ───────────────────────────────────────────────────────────────────

export class IngestOneError extends Error {
  readonly name = 'IngestOneError';
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// ── Core pipeline ───────────────────────────────────────────────────────────

/**
 * Run the single-event ingestion pipeline.
 *
 * The caller MUST have already:
 *   - Zod-validated the request body against {@link IngestEventRequest}
 *     (the frozen DTO from `@teamem/schema`)
 *   - Resolved the auth context (credential + principal from the Bearer token)
 *   - Verified the caller's scope includes the requested project
 *
 * This function does NOT perform scope checks — the caller is responsible
 * for ensuring that `auth.teamId` and `auth.projectId` are within the
 * caller's authorised scope before invoking this function.
 *
 * Pipeline steps (order is contractually frozen — red line 5.3):
 *   1. Strip `<private>` tags from the payload
 *   2. Compute the payload hash on the REDACTED content (N1)
 *   3. Derive channel/delivery/item facts for the CLI channel
 *   4. Insert idempotently via the events repository
 *   5. On duplicate: look up the original job (best-effort) and return
 *   6. On insert + compile=true: create a compile job in the database
 *   7. If a queue is available and the job was newly created: enqueue it
 *
 * @throws IngestOneError — idempotency conflict (same key, different payload)
 * @throws Error — database or job creation failure
 */
export async function ingestOne(
  deps: IngestOneDeps,
  request: IngestEventRequest,
  auth: IngestOneAuth,
): Promise<IngestOneResult> {
  const { db, queue } = deps;

  // ── Step 1: Strip private tags from payload (BEFORE hashing/persistence) ─
  const redactedPayload = stripPrivateTags(request.payload) as Record<
    string,
    unknown
  >;

  // ── Step 2: Compute payload hash & byte length on the REDACTED content ───
  const hash = payloadHash(redactedPayload);
  const byteLen = payloadByteLength(redactedPayload);

  // ── Step 3: Derive channel/delivery/item facts ─────────────────────────
  // For the CLI channel, the idempotencyKey IS the deliveryId (the CLI
  // generates it from (repo + commitSha + path) content hash). The itemKey
  // is always 'root' for a single-event request.
  // Actor provenance: client-supplied actors are ALWAYS `client_claimed`
  // (red line 5.4 — preserve original facts; never fabricate).
  // occurredAt provenance: client-provided timestamps are `client`;
  // when absent the server assigns `now` with `server` provenance.
  const now = new Date();

  const eventResult = await (async () => {
    try {
      return await insertEvent(db, {
        teamId: auth.teamId,
        projectId: auth.projectId,
        channel: CHANNEL,
        kind: KIND,
        connectorKind: CONNECTOR_KIND,
        deliveryId: request.idempotencyKey,
        itemKey: 'root',
        externalId: request.source.externalId,
        url: request.source.url ?? null,
        actor: request.actor ?? null,
        actorProvenance: request.actor ? 'client_claimed' : 'unknown',
        actorPrincipalId: null, // client_claimed never creates a contributor
        occurredAt: request.occurredAt ? new Date(request.occurredAt) : now,
        occurredAtProvenance: request.occurredAt ? 'client' : 'server',
        ingestedByCredentialId: auth.credentialId,
        ingestedByPrincipalId: auth.principalId,
        payload: redactedPayload,
        payloadHash: hash,
        payloadBytes: byteLen,
        payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
        envelopeVersion: EVENT_ENVELOPE_VERSION,
      });
    } catch (err) {
      if (err instanceof RepoIdempotencyConflictError) {
        throw new IngestOneError(
          'idempotency_conflict: same key, different payload hash',
          'idempotency_conflict',
        );
      }
      throw err;
    }
  })();

  const { eventId, status } = eventResult;

  // ── Step 4: Duplicate replay — look up original job (best-effort) ──────
  if (status === 'duplicate') {
    let originalJobId: string | null = null;
    try {
      const existingJob = await findJobByIdempotencyKey(
        db,
        auth.teamId,
        auth.projectId,
        'ingest_event',
        `compile:${eventId}`,
      );
      originalJobId = existingJob?.id ?? null;
    } catch {
      // Best-effort lookup — if it fails, return null. The replay is still
      // correct; just omits the optional job reference.
    }

    return { eventId, status: 'duplicate', jobId: originalJobId };
  }

  // ── Step 5: Optionally create a compile job ───────────────────────────
  let jobId: string | null = null;

  if (request.options.compile) {
    const compileJobIdempotencyKey = `compile:${eventId}`;
    try {
      const jobResult = await createJob(db, {
        teamId: auth.teamId,
        projectId: auth.projectId,
        kind: 'ingest_event',
        initiatedByKind: 'credential',
        initiatedByCredentialId: auth.credentialId,
        initiatedByPrincipalId: auth.principalId,
        idempotencyKey: compileJobIdempotencyKey,
        idempotencyRequestHash: hash,
        eventCount: 1,
      });
      jobId = jobResult.job.id;

      // Enqueue in pg-boss only when the job was newly created AND a
      // queue instance is available. If the job already existed (race
      // condition where two callers share the same compile key), skip
      // the enqueue — the original caller already enqueued it.
      if (queue && jobResult.created) {
        try {
          await queue.send({ jobId, eventId });
        } catch (err) {
          // Enqueue failure does not roll back the event or job — the job
          // row already exists and can be picked up by the worker later.
          // Log the failure so operators can investigate.
          console.error(
            JSON.stringify({
              event: 'compile_enqueue_failed',
              jobId,
              eventId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    } catch (err) {
      if (err instanceof JobIdempotencyConflictError) {
        // Job-level idempotency conflict — this shouldn't normally happen
        // since we use the eventId in the key, but handle gracefully by
        // returning the existing job id.
        console.error(
          JSON.stringify({
            event: 'compile_job_conflict',
            eventId,
            error: err.message,
          }),
        );
        jobId = err.existingJobId;
      } else {
        // Job creation failed for a non-idempotency reason. The event IS
        // persisted, but the caller asked for compile=true. Fail the
        // operation rather than silently returning jobId:null.
        throw new Error(
          `Failed to create compile job for event ${eventId}`,
          { cause: err },
        );
      }
    }
  }

  return { eventId, status: 'inserted', jobId };
}
