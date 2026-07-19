/**
 * POST /v1/events — public ingestion endpoint (M0-ING-03).
 *
 * Freezes the request/response DTO contract from @teamem/schema/ingest.ts
 * with precise HTTP status semantics: 200/202/400/401/403/409.
 *
 * Pipeline order (red line 5.3): validate → stripPrivateTags → persist → enqueue.
 * Every response uses the frozen error envelope on failure.
 */
import { ingestEventRequest, type IngestEventResponse, PAYLOAD_SCHEMA_VERSION, EVENT_ENVELOPE_VERSION } from '@teamem/schema';
import type { Context } from 'hono';
import type { AppDb } from '../../db/client.js';
import { insertEvent, IdempotencyConflictError as RepoIdempotencyConflictError } from '../../db/repositories/events.js';
import { createJob, findJobByIdempotencyKey, IdempotencyConflictError as JobIdempotencyConflictError } from '../../db/repositories/jobs.js';
import { resolveTokenHash, AuthenticationError } from '../../db/repositories/api-keys.js';
import { hashToken, parseBearerToken } from '../../auth/api-key.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import { stripPrivateTags } from '../../security/private-tags.js';
import { payloadHash, payloadByteLength } from '../../security/payload-hash.js';
import { InvalidRequestError, UnauthorizedError, ForbiddenError, NotFoundError, InternalError, IdempotencyConflictError, PayloadTooLargeError, REQUEST_ID_KEY } from '../errors.js';
import type { CompileQueue } from '../../queue/boss.js';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';

// ── Handler dependencies ────────────────────────────────────────────────────

export interface EventsWriteDeps {
  db: AppDb;
  /** Optional compile queue — when absent, compile=true jobs are created but
   *  not enqueued (useful for testing without a running pg-boss instance). */
  queue?: CompileQueue;
}

// ── Event kind / provenance constants for the public REST channel ───────────

const CHANNEL = 'cli' as const;
const KIND = 'cli_init' as const;
const CONNECTOR_KIND = 'cli' as const;

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /v1/events handler.
 *
 * Authenticates via Bearer token, validates the request body against the
 * frozen `ingestEventRequest` schema, strips `<private>` tags, computes the
 * payload hash, persists idempotently, optionally creates a compile job,
 * and returns the appropriate HTTP status with the frozen response DTO.
 */
export async function postEventsHandler(c: Context, deps: EventsWriteDeps): Promise<Response> {
  const { db, queue } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;

  // ── Step 1: Authenticate ──────────────────────────────────────────────
  const authHeader = c.req.header('authorization') ?? null;
  const token = parseBearerToken(authHeader);
  if (!token) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }

  const tokenHash = hashToken(token);

  let auth;
  try {
    auth = await resolveTokenHash(db, tokenHash);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      throw new UnauthorizedError('invalid or revoked API key');
    }
    throw new InternalError('authentication lookup failed', { cause: err });
  }

  // ── Step 2: Authorize — must have events:write scope ──────────────────
  if (!auth.scopes.includes('events:write')) {
    throw new ForbiddenError('API key does not have events:write scope');
  }

  // ── Step 3: Parse & validate request body ─────────────────────────────
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new InvalidRequestError('Request body is not valid JSON');
  }

  const parsed = ingestEventRequest.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError('Request body validation failed', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  const req = parsed.data;

  // ── Step 4: Scope check — requested project must be within key's scope ─
  const teamId = getTeamId(auth.scope);

  if (isProjectScope(auth.scope)) {
    // Key is bound to a specific project
    const keyProjectId = getProjectId(auth.scope);
    if (req.projectId !== keyProjectId) {
      throw new ForbiddenError(
        `API key does not have access to project ${req.projectId}`,
      );
    }
  } else {
    // allProjects key — verify the project exists AND belongs to the key's
    // team.  Cross-team projects must return 404 (same as genuinely missing,
    // per anti-enumeration).  Without the team_id filter a team-A key could
    // submit team-B's projectId, pass this check, and hit a composite-FK
    // violation inside insertEvent → wrapped as 500 instead of 403/404.
    const projectRows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.teamId, teamId),
          eq(schema.projects.id, req.projectId),
        ),
      )
      .limit(1);
    if (projectRows.length === 0) {
      throw new NotFoundError(
        `Project ${req.projectId} not found`,
      );
    }
  }

  // ── Step 5: Strip private tags from payload (BEFORE hashing/persistence) ─
  const redactedPayload = stripPrivateTags(req.payload) as Record<string, unknown>;

  // ── Step 6: Compute payload hash & byte length on the REDACTED content ─
  const hash = payloadHash(redactedPayload);
  const byteLen = payloadByteLength(redactedPayload);

  // ── Step 7: Idempotent event insert ───────────────────────────────────
  const now = new Date();
  const eventResult = await (async () => {
    try {
      return await insertEvent(db, {
        teamId,
        projectId: req.projectId,
        channel: CHANNEL,
        kind: KIND,
        connectorKind: CONNECTOR_KIND,
        deliveryId: req.idempotencyKey,
        itemKey: 'root',
        externalId: req.source.externalId,
        url: req.source.url ?? null,
        actor: req.actor ?? null,
        actorProvenance: req.actor ? 'client_claimed' : 'unknown',
        actorPrincipalId: null, // client_claimed never creates a contributor
        occurredAt: req.occurredAt ? new Date(req.occurredAt) : now,
        occurredAtProvenance: req.occurredAt ? 'client' : 'server',
        ingestedByCredentialId: auth.credentialId,
        ingestedByPrincipalId: auth.principal?.id ?? null,
        payload: redactedPayload,
        payloadHash: hash,
        payloadBytes: byteLen,
        payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
        envelopeVersion: EVENT_ENVELOPE_VERSION,
      });
    } catch (err) {
      if (err instanceof RepoIdempotencyConflictError) {
        throw new IdempotencyConflictError(
          'idempotency_conflict: same key, different payload hash',
          { cause: err },
        );
      }
      throw new InternalError('event insert failed', { cause: err });
    }
  })();

  // ── Step 8: Build response ────────────────────────────────────────────
  const { eventId, status } = eventResult;

  if (status === 'duplicate') {
    // 200 duplicate replay — return the ORIGINAL result, not a blank slate.
    // If the first request had compile=true and created a job, the replay
    // must include that jobId so the caller sees the same response.
    let originalJobId: string | null = null;
    try {
      const existingJob = await findJobByIdempotencyKey(
        db,
        teamId,
        req.projectId,
        'ingest_event',
        `compile:${eventId}`,
      );
      originalJobId = existingJob?.id ?? null;
    } catch {
      // Best-effort lookup — if it fails, return null (the replay is still
      // correct; just omits the optional job reference).
    }

    const response: IngestEventResponse = {
      requestId,
      eventId,
      jobId: originalJobId,
      duplicate: true,
    };
    return c.json(response, 200);
  }

  // ── Step 9: Optionally create a compile job ───────────────────────────
  let jobId: string | null = null;

  if (req.options.compile) {
    const compileJobIdempotencyKey = `compile:${eventId}`;
    try {
      const jobResult = await createJob(db, {
        teamId,
        projectId: req.projectId,
        kind: 'ingest_event',
        initiatedByKind: 'credential',
        initiatedByCredentialId: auth.credentialId,
        initiatedByPrincipalId: auth.principal?.id ?? null,
        idempotencyKey: compileJobIdempotencyKey,
        idempotencyRequestHash: hash,
        eventCount: 1,
      });
      jobId = jobResult.job.id;

      // Enqueue in pg-boss if a queue is available
      if (queue && jobResult.created) {
        try {
          await queue.send({ jobId, eventId });
        } catch (err) {
          // Enqueue failure does not roll back the event or job — the job
          // row already exists and can be picked up by the worker later.
          console.error(
            JSON.stringify({
              event: 'compile_enqueue_failed',
              requestId,
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
        // since we use the eventId in the key, but handle gracefully.
        console.error(
          JSON.stringify({
            event: 'compile_job_conflict',
            requestId,
            eventId,
            error: err.message,
          }),
        );
        jobId = err.existingJobId;
      } else {
        // Job creation failed for a non-idempotency reason (e.g. FK
        // violation, connection error).  The event IS persisted, but the
        // caller asked for compile=true and we could not schedule it.
        // Fail the request rather than returning 202 jobId:null and
        // pretending compilation was requested successfully.
        throw new InternalError(
          'Failed to create compile job',
          { cause: err },
        );
      }
    }
  }

  // ── Step 10: Wait semantics (wait=true — poll up to 30s) ─────────────
  // For M0 scope, wait=true with compile=true polls for job completion.
  // If the queue is unavailable or compile=false, this is a no-op.
  if (req.options.wait && req.options.compile && jobId) {
    const deadline = Date.now() + 30_000;
    let completed = false;
    let conceptIds: string[] | undefined;

    while (Date.now() < deadline) {
      try {
        const { getJob } = await import('../../db/repositories/jobs.js');
        const job = await getJob(db, auth.scope, jobId);
        if (job && (job.status === 'completed' || job.status === 'failed')) {
          completed = true;
          if (job.status === 'completed') {
            // Fetch concept UUIDs from job_events
            const { getJobEvents } = await import('../../db/repositories/jobs.js');
            const events = await getJobEvents(db, teamId, req.projectId, jobId);
            conceptIds = events
              .filter((e) => e.conceptUuids && e.conceptUuids.length > 0)
              .flatMap((e) => e.conceptUuids as string[]);
          }
          break;
        }
      } catch {
        // Ignore polling errors; continue waiting
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (completed) {
      const response: IngestEventResponse = {
        requestId,
        eventId,
        jobId,
        duplicate: false,
        conceptIds,
      };
      return c.json(response, 200);
    }

    // Timed out
    const response: IngestEventResponse = {
      requestId,
      eventId,
      jobId,
      duplicate: false,
      timedOut: true,
    };
    return c.json(response, 202);
  }

  // ── Default: 202 accepted ─────────────────────────────────────────────
  const response: IngestEventResponse = {
    requestId,
    eventId,
    jobId,
    duplicate: false,
  };
  return c.json(response, 202);
}

// ── Body-size guard (inline to avoid circular dependency with server.ts) ────

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB batch limit (contract ②)

function enforceBodyLimit() {
  return async (c: Context, next: () => Promise<void>) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError(`Body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    await next();
  };
}

// ── Route registration ──────────────────────────────────────────────────────

import { Hono } from 'hono';

/**
 * Build the POST /v1/events route with all middleware and error handling.
 *
 * The returned Hono instance can be mounted into the main app. Dependencies
 * (db, queue) are injected via the factory parameter rather than relying on
 * environment variables.
 */
export function buildEventsWriteRoutes(deps: EventsWriteDeps): Hono {
  const routes = new Hono();

  routes.use('/v1/events', enforceBodyLimit());
  routes.post('/v1/events', async (c) => {
    return postEventsHandler(c, deps);
  });

  return routes;
}
