/**
 * Events query route handler (AGPL-3.0-only).
 *
 * GET /v1/events — list events with cursor pagination, scoped by
 * team_id + project_id (red line 5.5). Returns event summaries (no
 * payload — payload access requires read:payload scope).
 *
 * M0 minimal implementation: lists the most recent events for a
 * configured team/project. Full cursor pagination and scope enforcement
 * via API keys are M1 scope.
 */
import type { Context } from 'hono';
import * as schema from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import type { WebhookScope } from './webhooks.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /v1/events
 *
 * Query params:
 *   - limit (optional, default 20, max 100)
 *   - kind (optional filter)
 *
 * Returns: { events: { id, channel, kind, sourceEvent, sourceAction,
 *   deliveryId, itemKey, externalId, url, actorProvenance,
 *   occurredAt, createdAt }[], total?: number }
 */
export function listEventsHandler(db: AppDb, scope: WebhookScope) {
  return async (c: Context): Promise<Response> => {
    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit) {
      limit = parseInt(rawLimit, 10);
      if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) {
        return c.json(
          { error: { code: 'invalid_request', message: `limit must be 1-${MAX_LIMIT}` } },
          400,
        );
      }
    }

    const kindFilter = c.req.query('kind');

    const conditions = [
      eq(schema.events.teamId, scope.teamId),
      eq(schema.events.projectId, scope.projectId),
    ];

    if (kindFilter) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conditions.push(eq(schema.events.kind, kindFilter as any));
    }

    try {
      const rows = await db
        .select({
          id: schema.events.id,
          channel: schema.events.channel,
          kind: schema.events.kind,
          connectorKind: schema.events.connectorKind,
          sourceEvent: schema.events.sourceEvent,
          sourceAction: schema.events.sourceAction,
          deliveryId: schema.events.deliveryId,
          itemKey: schema.events.itemKey,
          externalId: schema.events.externalId,
          url: schema.events.url,
          actorProvenance: schema.events.actorProvenance,
          occurredAtProvenance: schema.events.occurredAtProvenance,
          occurredAt: schema.events.occurredAt,
          createdAt: schema.events.createdAt,
          actorPrincipalId: schema.events.actorPrincipalId,
        })
        .from(schema.events)
        .where(and(...conditions))
        .orderBy(desc(schema.events.createdAt), desc(schema.events.id))
        .limit(limit);

      // Count total (without limit)
      const countRows = await db
        .select({ count: schema.events.id })
        .from(schema.events)
        .where(and(...conditions));

      return c.json({
        events: rows,
        total: countRows.length,
      });
    } catch (err) {
      // Let global error handler deal with it — never leak SQL
      throw err;
    }
  };
}
