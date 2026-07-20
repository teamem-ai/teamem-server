/**
 * GET /v1/events and GET /v1/events/:id — event list and detail queries (M0-READ-01).
 *
 * Delivers:
 * - Scoped summary list (no payload) ordered by created_at desc + id,
 *   sourceKind filter, composite cursor, strict limit enforcement.
 * - Detail with redacted payload (requires read:payload scope), fail-closed
 *   audit on every payload read.
 *
 * Contract frozen in @teamem/schema/event.ts: eventListQuery, eventListResponse,
 * eventDetailResponse. The response DTOs are the single source of truth — the
 * route maps DB rows to those shapes without duplication.
 */
import {
  eventListQuery,
  eventListResponse,
  eventDetailResponse,
  type EventSummary,
  type EventDetail,
} from '@teamem/schema';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppDb } from '../../db/client.js';
import {
  listEvents,
  getEventById,
  type EventRow,
} from '../../db/repositories/events.js';
import { requireAuth, requireScope, getAuth } from '../auth.js';
import {
  getTeamId,
  getProjectId,
  isProjectScope,
} from '../../auth/scope.js';
import { auditPayloadRead, AuditWriteFailedError } from '../../db/repositories/audit.js';
import {
  InvalidRequestError,
  NotFoundError,
  ForbiddenError,
  InternalError,
  CursorInvalidError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── DTO mapping helpers ────────────────────────────────────────────────────

/**
 * Map a database EventRow to the wire EventSummary DTO (no payload).
 *
 * The `source` field is assembled from the denormalised columns:
 * channel, kind, sourceEvent, sourceAction, deliveryId, itemKey,
 * externalId, url, and optionally connectorKind.
 */
function toSummary(row: EventRow): EventSummary {
  const sourceObj: Record<string, unknown> = {
    channel: row.channel,
    kind: row.kind,
    deliveryId: row.deliveryId,
    itemKey: row.itemKey,
    externalId: row.externalId,
  };

  if (row.sourceEvent) sourceObj['event'] = row.sourceEvent;
  if (row.sourceAction) sourceObj['action'] = row.sourceAction;
  if (row.url) sourceObj['url'] = row.url;

  // connectorKind is only included when channel is 'external' (v0.3 additive).
  // Including it for built-in channels violates the source superRefine.
  if (row.channel === 'external') {
    sourceObj['connectorKind'] = row.connectorKind;
  }

  return {
    id: row.id,
    projectId: row.projectId,
    source: sourceObj as EventSummary['source'],
    actor: row.actor as EventSummary['actor'],
    actorProvenance: row.actorProvenance as EventSummary['actorProvenance'],
    occurredAt: row.occurredAt.toISOString(),
    occurredAtProvenance: row.occurredAtProvenance as EventSummary['occurredAtProvenance'],
    ingestedBy: {
      credentialId: row.ingestedByCredentialId,
      principalId: row.ingestedByPrincipalId,
    },
    payloadBytes: row.payloadBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Map a database EventRow to the wire EventDetail DTO (includes payload).
 *
 * The payload is the POST-strip stored content — no queryable pre-strip
 * version exists anywhere in the system (N7).
 */
function toDetail(row: EventRow): EventDetail {
  return {
    ...toSummary(row),
    payload: row.payload,
  };
}

// ── Handler dependencies ────────────────────────────────────────────────────

export interface EventsReadDeps {
  db: AppDb;
}

// ── GET /v1/events handler ─────────────────────────────────────────────────

async function getEventsListHandler(c: Context, deps: EventsReadDeps): Promise<Response> {
  const { db } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;

  const auth = getAuth(c);

  // Parse query parameters against the frozen contract.
  const rawQuery = {
    projectId: c.req.query('projectId'),
    sourceKind: c.req.query('sourceKind') || undefined,
    cursor: c.req.query('cursor') || undefined,
    limit: c.req.query('limit'),
  };

  const parsed = eventListQuery.safeParse(rawQuery);
  if (!parsed.success) {
    throw new InvalidRequestError('Invalid query parameters', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  const { projectId, sourceKind, cursor, limit } = parsed.data;

  // Scope enforcement: project-scoped key can only list its own project.
  if (isProjectScope(auth.scope)) {
    const scopeProjectId = getProjectId(auth.scope);
    if (projectId !== scopeProjectId) {
      // Return empty list rather than 403 — the caller already knows the
      // project exists (it has a valid key), so this is a scope mismatch
      // on the query parameter, not an authorization bypass.
      throw new ForbiddenError(
        `API key does not have access to project ${projectId}`,
      );
    }
  }

  // List with cursor pagination
  let result;
  try {
    result = await listEvents(db, {
      scope: auth.scope,
      projectId,
      sourceKind,
      cursor,
      limit,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'cursor_invalid') {
      throw new CursorInvalidError();
    }
    throw new InternalError('event list query failed', { cause: err });
  }

  // Map DB rows → DTOs
  const summaries: EventSummary[] = result.rows.map(toSummary);

  // Validate response shape against the frozen contract
  const response = eventListResponse.parse({
    requestId,
    data: summaries,
    nextCursor: result.nextCursor,
  });

  return c.json(response, 200);
}

// ── GET /v1/events/:id handler ─────────────────────────────────────────────

async function getEventDetailHandler(c: Context, deps: EventsReadDeps): Promise<Response> {
  const { db } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;

  const auth = getAuth(c);

  const rawEventId = c.req.param('id');
  const rawProjectId = c.req.query('projectId');

  if (!rawProjectId) {
    throw new InvalidRequestError('Missing required query parameter: projectId');
  }
  if (!rawEventId) {
    throw new InvalidRequestError('Missing event ID in path');
  }

  // Validate projectId format
  if (!/^prj_[A-Za-z0-9]+$/.test(rawProjectId)) {
    throw new InvalidRequestError('Invalid projectId format');
  }

  // Validate eventId format
  if (!/^evt_[A-Za-z0-9]+$/.test(rawEventId)) {
    throw new InvalidRequestError('Invalid eventId format');
  }

  const projectId: string = rawProjectId;
  const eventId: string = rawEventId;

  // Scope enforcement
  if (isProjectScope(auth.scope)) {
    const scopeProjectId = getProjectId(auth.scope);
    if (projectId !== scopeProjectId) {
      throw new ForbiddenError(
        `API key does not have access to project ${projectId}`,
      );
    }
  }

  const row = await getEventById(db, auth.scope, projectId, eventId);

  if (!row) {
    // Identical 404 for genuinely missing and cross-team IDs (anti-enumeration).
    throw new NotFoundError();
  }

  // Fail-closed payload read audit (N7): if the audit write fails, the
  // payload read is denied — the detail response must not be returned.
  try {
    await auditPayloadRead(db, {
      requestId,
      principalId: auth.principal?.id ?? null,
      credentialId: auth.credentialId,
      teamId: getTeamId(auth.scope),
      projectId,
      resourceId: eventId,
    });
  } catch (err) {
    if (err instanceof AuditWriteFailedError) {
      throw new InternalError('Payload read audit failed; access denied', {
        cause: err,
      });
    }
    throw err;
  }

  const detail = toDetail(row);

  const response = eventDetailResponse.parse({
    requestId,
    data: detail,
  });

  return c.json(response, 200);
}

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the GET /v1/events and GET /v1/events/:id routes.
 *
 * The returned Hono instance can be mounted into the main app. Dependencies
 * (db) are injected via the factory parameter.
 */
export function buildEventsReadRoutes(deps: EventsReadDeps): Hono {
  const routes = new Hono();

  // GET /v1/events/:id — detail with payload (requires read:payload)
  // MUST be registered BEFORE the list route because /v1/events/:id is
  // more specific and Hono evaluates routes in registration order.
  routes.use('/v1/events/:id', requireAuth(deps.db));
  routes.use('/v1/events/:id', requireScope('read', 'read:payload'));
  routes.get('/v1/events/:id', async (c) => getEventDetailHandler(c, deps));

  // GET /v1/events — scoped summary list (no payload)
  routes.use('/v1/events', requireAuth(deps.db));
  routes.use('/v1/events', requireScope('read'));
  routes.get('/v1/events', async (c) => getEventsListHandler(c, deps));

  return routes;
}
