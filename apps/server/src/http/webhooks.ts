/**
 * GitHub webhook route handler (AGPL-3.0-only).
 *
 * POST /v1/events/github — receives GitHub webhook deliveries, verifies
 * their signature, normalizes them through the GitHub connector, and
 * persists each resulting NormalizedEvent through the connector storage
 * layer. Returns per-event results in the frozen event result envelope.
 *
 * Red lines:
 *   - Raw body is read via `c.req.raw.clone().arrayBuffer()` so signature
 *     verification runs against the original bytes (hard constraint).
 *   - Events are always scoped by team_id + project_id (red line 5.5).
 *   - The payload passes through receive → Zod validate → stripPrivateTags →
 *     persist → enqueue order (§5.3). The connector-storage layer handles
 *     redaction; this handler only pipes the raw bytes through.
 *   - Duplicate deliveries (same idempotency identity + same hash) return
 *     the original result (N1 idempotent replay).
 *   - Different hash → 409 idempotency_conflict.
 */
import type { Context } from 'hono';
import { getConnector } from '../connectors/registry.js';
import {
  persistNormalizedEvent,
  IdempotencyConflictError as StorageIdempotencyConflictError,
} from '../connectors/connector-storage.js';
import { SignatureVerificationError } from '../connectors/github/signature.js';
import type { AppDb } from '../db/client.js';
import type { ConnectorScope } from '../connectors/connector-storage.js';

/** M0 fixed scope for webhook delivery — derived from the configured project. */
export interface WebhookScope {
  readonly teamId: string;
  readonly projectId: string;
}

/**
 * POST /v1/events/github
 *
 * Accepts: raw GitHub webhook body (application/json)
 * Headers required: X-GitHub-Delivery, X-GitHub-Event
 * Headers optional: X-Hub-Signature-256 (verified when webhook secret is configured)
 *
 * Returns: { events: { eventId, status, channel, kind, connectorKind, duplicate }[] }
 */
export function githubWebhookHandler(db: AppDb, scope: WebhookScope) {
  return async (c: Context): Promise<Response> => {
    // Resolve the GitHub connector (must be registered at startup).
    const connector = getConnector('github');
    if (!connector) {
      return c.json(
        { error: { code: 'internal', message: 'GitHub connector not registered' } },
        503,
      );
    }

    // Read raw body bytes BEFORE any JSON parsing — signature verification
    // requires the original bytes (hard constraint, §8).
    let rawBody: Buffer;
    try {
      const arrayBuffer = await c.req.raw.clone().arrayBuffer();
      rawBody = Buffer.from(arrayBuffer);
    } catch {
      return c.json(
        { error: { code: 'invalid_request', message: 'Cannot read request body' } },
        400,
      );
    }

    // Build the WebhookRequest for the connector.
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(c.req.header())) {
      headers[key] = value;
    }

    // Normalize through the connector (signature verification + parsing).
    let normalizedEvents;
    try {
      normalizedEvents = await connector.handleWebhook({ headers, rawBody });
    } catch (err) {
      if (err instanceof SignatureVerificationError) {
        return c.json(
          { error: { code: 'unauthorized', message: err.message } },
          401,
        );
      }
      throw err; // Re-throw to global error handler
    }

    if (normalizedEvents.length === 0) {
      return c.json({
        events: [],
        note: 'No events produced — event type unsupported or payload was noise',
      });
    }

    // Persist each normalized event through the connector storage layer.
    const connectorScope: ConnectorScope = {
      teamId: scope.teamId,
      projectId: scope.projectId,
    };

    const results: Array<{
      eventId: string;
      status: 'inserted' | 'duplicate';
      channel: string;
      kind: string;
      connectorKind: string;
      principalId: string | null;
    }> = [];

    let hadConflict = false;
    for (const ev of normalizedEvents) {
      try {
        const result = await persistNormalizedEvent(db, connectorScope, ev);
        results.push({
          eventId: result.eventId,
          status: result.duplicate ? 'duplicate' : 'inserted',
          channel: result.channel,
          kind: ev.eventKind,
          connectorKind: result.connectorKind,
          principalId: result.principalId,
        });
      } catch (err) {
        if (err instanceof StorageIdempotencyConflictError) {
          hadConflict = true;
          results.push({
            eventId: 'conflict',
            status: 'duplicate',
            channel: 'unknown',
            kind: ev.eventKind,
            connectorKind: ev.connectorKind,
            principalId: null,
          });
        } else {
          throw err; // Re-throw unexpected errors
        }
      }
    }

    const statusCode = hadConflict ? 409 : 200;
    return c.json({ events: results }, statusCode as never);
  };
}
