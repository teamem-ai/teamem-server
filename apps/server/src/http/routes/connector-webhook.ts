/**
 * Connector webhook route — POST /v1/connectors/:connectorKind/webhook
 * (M0-GH-08 / DUA-148).
 *
 * Receives raw webhook body bytes, dispatches through the connector registry,
 * and stitches the full pipeline for each returned NormalizedEvent:
 *
 *   stripPrivateTags → persistNormalizedEvent (idempotent) → create compile job
 *
 * Unsupported events (connector returns []) receive an honest 200 with
 * `{ accepted: 0, ignored: N }` and produce zero data rows or jobs.
 *
 * Auth: webhook signature verification (inside the connector) replaces
 * Bearer-token auth. No API key is required — the signature IS the auth.
 *
 * Red lines honoured:
 *   - Redact before persistence (5.3)
 *   - Every business query explicitly carries team_id (5.5)
 *   - Unsupported events → no rows, no jobs (§5.1)
 *   - Idempotency via (project, channel, connectorKind, deliveryId, itemKey)
 */
import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import type { AppDb } from '../../db/client.js';
import type { CompileQueue } from '../../queue/boss.js';
import { getConnector } from '../../connectors/registry.js';
import {
  persistNormalizedEvent,
  IdempotencyConflictError as StorageIdempotencyConflictError,
  InvalidNormalizedEventError,
  type ConnectorScope,
} from '../../connectors/connector-storage.js';
import { createJob, IdempotencyConflictError as JobIdempotencyConflictError } from '../../db/repositories/jobs.js';
import { stripPrivateTags } from '../../security/private-tags.js';
import { payloadHash } from '../../security/payload-hash.js';
import {
  REQUEST_ID_KEY,
  InvalidRequestError,
  NotFoundError,
  InternalError,
} from '../errors.js';
import { SignatureVerificationError } from '../../connectors/github/signature.js';

// ── Query-param validation ──────────────────────────────────────────────────

const webhookQuerySchema = z.strictObject({
  project: z
    .string()
    .min(1)
    .regex(/^prj_[A-Za-z0-9]+$/, 'project must be a valid project ID (prj_…)'),
});

// ── Response DTOs ───────────────────────────────────────────────────────────

export interface WebhookEventResult {
  readonly index: number;
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  readonly eventId?: string;
  readonly error?: { code: string; message: string };
}

export interface WebhookResponse {
  readonly requestId: string;
  readonly accepted: number;
  readonly duplicate: number;
  readonly ignored: number;
  readonly results: readonly WebhookEventResult[];
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface ConnectorWebhookDeps {
  readonly db: AppDb;
  readonly queue?: CompileQueue;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function postWebhookHandler(
  c: Context,
  deps: ConnectorWebhookDeps,
): Promise<Response> {
  const { db, queue } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;

  // 1. Validate query params
  const rawQuery = {
    project: c.req.query('project'),
  };
  const queryParsed = webhookQuerySchema.safeParse(rawQuery);
  if (!queryParsed.success) {
    throw new InvalidRequestError(
      `Invalid query parameters: ${queryParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const { project: projectId } = queryParsed.data;

  // 2. Resolve project → team scope (red line 5.5)
  const projectRows = await db
    .select({ teamId: schema.projects.teamId, id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);

  if (projectRows.length === 0) {
    throw new NotFoundError(`Project ${projectId} not found`);
  }

  const scope: ConnectorScope = {
    teamId: projectRows[0]!.teamId,
    projectId: projectRows[0]!.id,
  };

  // 3. Look up connector by kind
  const connectorKind = c.req.param('connectorKind') ?? '';
  if (!connectorKind) {
    throw new InvalidRequestError('Missing connector kind in path');
  }
  const connector = getConnector(connectorKind);
  if (!connector) {
    throw new NotFoundError(
      `Connector '${connectorKind}' is not registered`,
    );
  }

  // 4. Get raw body bytes (before any JSON parse or body consumption).
  //    Use the original Request object — text() consumes the body stream
  //    but we only need it once for signature verification.
  const bodyText = await c.req.raw.text();
  const rawBody = Buffer.from(bodyText, 'utf-8');

  // 5. Call connector.handleWebhook() — signature verification happens inside
  let normalizedEvents: Awaited<ReturnType<typeof connector.handleWebhook>>;
  try {
    // Collect headers from the Request object. Headers is a Headers
    // class, NOT a plain object — we must use .forEach() to iterate.
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    normalizedEvents = await connector.handleWebhook({
      headers,
      rawBody,
    });
  } catch (err) {
    if (err instanceof SignatureVerificationError) {
      // Signature failure → 401 (never leak the secret or body)
      const body = buildErrorResponse(
        requestId,
        'unauthorized',
        'Webhook signature verification failed',
      );
      return c.json(body, 401);
    }
    throw new InternalError('Webhook processing failed', { cause: err });
  }

  // 6. If no events returned, this is an "accepted/ignored" delivery
  if (normalizedEvents.length === 0) {
    const response: WebhookResponse = {
      requestId,
      accepted: 0,
      duplicate: 0,
      ignored: 1,
      results: [],
    };
    return c.json(response, 200);
  }

  // 7. Persist each event (redact → persist → optional enqueue)
  const results: WebhookEventResult[] = [];
  let accepted = 0;
  let duplicateCount = 0;

  for (let i = 0; i < normalizedEvents.length; i++) {
    const rawEvent = normalizedEvents[i]!;

    try {
      // 7a. Strip private tags from payload (red line 5.3: before persistence)
      let redactedPayload = stripPrivateTags(rawEvent.payload) as Record<string, unknown>;

      // 7a2. Strip undefined values (canonicalJson rejects them)
      redactedPayload = JSON.parse(JSON.stringify(redactedPayload)) as Record<string, unknown>;

      // 7b. Reconstruct the event with redacted payload
      const redactedEvent = {
        ...rawEvent,
        payload: redactedPayload,
      };

      // 7c. Persist idempotently
      const persisted = await persistNormalizedEvent(db, scope, redactedEvent);

      if (persisted.duplicate) {
        duplicateCount++;
        results.push({
          index: i,
          status: 'duplicate',
          eventId: persisted.eventId,
        });
      } else {
        accepted++;
        results.push({
          index: i,
          status: 'accepted',
          eventId: persisted.eventId,
        });

        // 7d. Create compile job (only for newly persisted events)
        try {
          const compileJobKey = `compile:${persisted.eventId}`;
          const hash = payloadHash(redactedPayload);

          const jobResult = await createJob(db, {
            teamId: scope.teamId,
            projectId: scope.projectId,
            kind: 'ingest_event',
            initiatedByKind: 'connector',
            initiatedByConnector: connectorKind,
            idempotencyKey: compileJobKey,
            idempotencyRequestHash: hash,
            eventCount: 1,
          });

          // 7e. Enqueue in pg-boss if a queue is available
          if (queue && jobResult.created) {
            try {
              await queue.send({
                jobId: jobResult.job.id,
                eventId: persisted.eventId,
              });
            } catch (err) {
              // Enqueue failure does not roll back the event or job.
              console.error(
                JSON.stringify({
                  event: 'compile_enqueue_failed',
                  requestId,
                  jobId: jobResult.job.id,
                  eventId: persisted.eventId,
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          }
        } catch (err) {
          if (err instanceof JobIdempotencyConflictError) {
            console.error(
              JSON.stringify({
                event: 'compile_job_conflict',
                requestId,
                eventId: persisted.eventId,
                error: err.message,
              }),
            );
          } else {
            // Job creation failed for a non-idempotency reason.
            // The event IS persisted; log and continue.
            console.error(
              JSON.stringify({
                event: 'compile_job_creation_failed',
                requestId,
                eventId: persisted.eventId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof StorageIdempotencyConflictError) {
        results.push({
          index: i,
          status: 'rejected',
          error: { code: 'idempotency_conflict', message: err.message.slice(0, 200) },
        });
      } else if (err instanceof InvalidNormalizedEventError) {
        results.push({
          index: i,
          status: 'rejected',
          error: { code: 'invalid_request', message: err.message.slice(0, 200) },
        });
      } else {
        throw err; // Unexpected error → 500
      }
    }
  }

  const response: WebhookResponse = {
    requestId,
    accepted,
    duplicate: duplicateCount,
    ignored: 0,
    results,
  };
  return c.json(response, 200);
}

// ── Error response helper ───────────────────────────────────────────────────

function buildErrorResponse(
  requestId: string,
  code: string,
  message: string,
): { requestId: string; error: { code: string; message: string } } {
  return { requestId, error: { code, message } };
}

// ── Route registration ─────────────────────────────────────────────────────

/**
 * Build the POST /v1/connectors/:connectorKind/webhook route.
 *
 * This route intentionally bypasses the Bearer-token auth middleware —
 * webhook signature verification is the auth mechanism, performed inside
 * the connector's handleWebhook().
 */
export function buildConnectorWebhookRoutes(deps: ConnectorWebhookDeps): Hono {
  const routes = new Hono();

  routes.post('/v1/connectors/:connectorKind/webhook', async (c) => {
    return postWebhookHandler(c, deps);
  });

  return routes;
}
