/**
 * Idempotent Event Repository (DUA-177 / M0-DATA-04).
 *
 * Inserts events within an explicit tenant/project scope, preserving:
 *   - source facts (channel, kind, connectorKind, sourceEvent, sourceAction,
 *     deliveryId, itemKey, externalId, url)
 *   - actor claim and its provenance
 *   - occurredAt and its provenance (independent of actor trust, N8)
 *   - ingested-by credential and principal facts (server-derived)
 *
 * Idempotency identity (N1, hardened v0.3): (project_id, channel,
 * connector_kind, delivery_id, item_key). Three outcomes:
 *   1. inserted   — new row created
 *   2. duplicate  — same identity + same payload hash (returns original id)
 *   3. conflict   — same identity + different hash → IdempotencyConflictError
 *
 * The payload is assumed already redacted (private tags stripped) and
 * hashed by the caller — this repository only stores what it is given
 * (red line 5.3: validate → strip → persist order).
 */
import { randomUUID, createHash } from 'node:crypto';
import { and, eq, inArray as drizzleInArray, or, lt, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';
import type { ScopeContext } from '../../auth/scope.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import { encodeCursor, type CursorPayload } from '@teamem/schema';

// ── Error types ─────────────────────────────────────────────────────────────

/**
 * Thrown when the idempotency identity matches an existing event but the
 * payload hash differs (N1: 409 idempotency_conflict, never a silent overwrite).
 */
export class IdempotencyConflictError extends Error {
  readonly name = 'IdempotencyConflictError';
}

// ── Request / result types ──────────────────────────────────────────────────

/**
 * All fields required to insert an event row, including scope and
 * provenance facts. The caller is responsible for Zod validation,
 * private-tag redaction, payload hashing, and principal resolution;
 * this repository stores exactly what it receives.
 */
export interface EventInsertRequest {
  /** Tenant identity — required for every scoped query (red line 5.5). */
  readonly teamId: string;
  /** Project identity — together with teamId forms the composite scope. */
  readonly projectId: string;
  /** Source channel fact (N1): one of the closed source_channel values. */
  readonly channel: string;
  /** Parsed event kind: one of the closed source_kind values. */
  readonly kind: string;
  /** Open connector identity — always populated (v0.3 additive). */
  readonly connectorKind: string;
  /** Raw provider event name, if available (Q6). */
  readonly sourceEvent?: string | null;
  /** Raw provider action, if available (Q6). */
  readonly sourceAction?: string | null;
  /** Idempotency identity component — provider delivery identifier. */
  readonly deliveryId: string;
  /** Idempotency identity component — stable sub-item key within a delivery. */
  readonly itemKey: string;
  /** Human-meaningful external reference (e.g. "org/repo#42"). */
  readonly externalId: string;
  /** Optional URL to the original resource. */
  readonly url?: string | null;
  /** Raw actor claim, preserved verbatim (5.4). null when unknown. */
  readonly actor?: Record<string, unknown> | null;
  /** How the actor claim was acquired (N2). */
  readonly actorProvenance: string;
  /** Resolved principal id, or null when no principal was resolved. */
  readonly actorPrincipalId?: string | null;
  /** Source-event time — display on timelines (N8). */
  readonly occurredAt: Date;
  /** How occurredAt was obtained (N8: separate dimension from actor trust). */
  readonly occurredAtProvenance: string;
  /** Credential that submitted this event (server-derived, never client-supplied). */
  readonly ingestedByCredentialId?: string | null;
  /** Principal that submitted this event (server-derived, never client-supplied). */
  readonly ingestedByPrincipalId?: string | null;
  /** Redacted payload — pre-strip content must never reach this point (N7). */
  readonly payload: Record<string, unknown>;
  /** SHA-256 of canonical JSON of the REDACTED payload (N1). */
  readonly payloadHash: string;
  /** UTF-8 byte length of the canonical JSON representation. */
  readonly payloadBytes: number;
  /** @teamem/schema PAYLOAD_SCHEMA_VERSION at ingest time. */
  readonly payloadSchemaVersion: number;
  /** @teamem/schema EVENT_ENVELOPE_VERSION at ingest time. */
  readonly envelopeVersion: number;
}

/**
 * Outcome of an idempotent event insert.
 *
 * - `inserted`  → new event row committed; eventId is the new row's id.
 * - `duplicate` → same identity + same payload hash; eventId is the ORIGINAL
 *                 row's id, no new row was written.
 */
export interface EventInsertResult {
  readonly eventId: string;
  readonly status: 'inserted' | 'duplicate';
}

// ── Internal helpers ────────────────────────────────────────────────────────

interface ExistingEventRow {
  readonly id: string;
  readonly payloadHash: string;
}

/**
 * Look up an existing event by the full idempotency identity, always scoped
 * by team_id AND project_id (red line 5.5). projectId alone is never treated
 * as sufficient scope — a caller with a mismatched teamId must get nothing
 * back, not another tenant's event.
 */
async function findByIdentity(
  db: AppDb,
  teamId: string,
  projectId: string,
  channel: string,
  connectorKind: string,
  deliveryId: string,
  itemKey: string,
): Promise<ExistingEventRow | undefined> {
  const rows = await db
    .select({
      id: schema.events.id,
      payloadHash: schema.events.payloadHash,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.teamId, teamId),
        eq(schema.events.projectId, projectId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eq(schema.events.channel, channel as any),
        eq(schema.events.connectorKind, connectorKind),
        eq(schema.events.deliveryId, deliveryId),
        eq(schema.events.itemKey, itemKey),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Detect Postgres unique_violation (23505) on a specific named constraint. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const { code, constraint: violated } = cause as { code?: unknown; constraint?: unknown };
  return code === '23505' && violated === constraint;
}

function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, '')}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

// ── Event row shape for read-side consumers ──────────────────────────────

/**
 * Full event row as returned by read-side queries. Mirrors the Drizzle
 * schema columns that the compiler needs — id, source facts, actor,
 * provenance, payload, timestamps.
 */
export interface EventRow {
  readonly id: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly channel: string;
  readonly kind: string;
  readonly connectorKind: string;
  readonly sourceEvent: string | null;
  readonly sourceAction: string | null;
  readonly deliveryId: string;
  readonly itemKey: string;
  readonly externalId: string;
  readonly url: string | null;
  readonly actor: Record<string, unknown> | null;
  readonly actorProvenance: string;
  readonly actorPrincipalId: string | null;
  readonly occurredAt: Date;
  readonly occurredAtProvenance: string;
  readonly ingestedByCredentialId: string | null;
  readonly ingestedByPrincipalId: string | null;
  readonly payload: Record<string, unknown>;
  readonly payloadBytes: number;
  readonly payloadHash: string;
  readonly payloadSchemaVersion: number;
  readonly envelopeVersion: number;
  readonly createdAt: Date;
}

// Full-column SELECT for the events read-side shape.
const EVENT_COLUMNS = {
  id: schema.events.id,
  teamId: schema.events.teamId,
  projectId: schema.events.projectId,
  channel: schema.events.channel,
  kind: schema.events.kind,
  connectorKind: schema.events.connectorKind,
  sourceEvent: schema.events.sourceEvent,
  sourceAction: schema.events.sourceAction,
  deliveryId: schema.events.deliveryId,
  itemKey: schema.events.itemKey,
  externalId: schema.events.externalId,
  url: schema.events.url,
  actor: schema.events.actor,
  actorProvenance: schema.events.actorProvenance,
  actorPrincipalId: schema.events.actorPrincipalId,
  occurredAt: schema.events.occurredAt,
  occurredAtProvenance: schema.events.occurredAtProvenance,
  ingestedByCredentialId: schema.events.ingestedByCredentialId,
  ingestedByPrincipalId: schema.events.ingestedByPrincipalId,
  payload: schema.events.payload,
  payloadBytes: schema.events.payloadBytes,
  payloadHash: schema.events.payloadHash,
  payloadSchemaVersion: schema.events.payloadSchemaVersion,
  envelopeVersion: schema.events.envelopeVersion,
  createdAt: schema.events.createdAt,
};

// ── List query helpers ──────────────────────────────────────────────────────

/**
 * Parameters for a cursor-paginated event list query.
 * Sort: created_at desc, id desc (N8).
 */
export interface ListEventsParams {
  readonly scope: ScopeContext;
  readonly projectId: string;
  readonly sourceKind?: string;
  readonly cursor?: string;
  readonly limit: number;
}

/** Result of a list-events query. */
export interface ListEventsResult {
  readonly rows: EventRow[];
  readonly nextCursor: string | null;
}

/**
 * Compute a stable hash of the list filters so the cursor can detect
 * a changed filter set and reject the stale cursor (cursor_invalid, N3).
 */
function computeFilterHash(params: { sourceKind?: string }): string {
  const normalized = `sourceKind=${params.sourceKind ?? ''}`;
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/**
 * List events with cursor-based pagination, ordered by created_at DESC, id DESC.
 *
 * Supports optional sourceKind filtering. Every query includes both team_id
 * and project_id (red line 5.5). The cursor is a base64url-encoded JSON object
 * that carries the last-seen sort value, id, and a filter hash — tampered or
 * stale cursors are rejected as cursor_invalid.
 *
 * Returns up to `limit` rows + a nextCursor (null when no more pages).
 */
export async function listEvents(
  db: AppDb,
  params: ListEventsParams,
): Promise<ListEventsResult> {
  const teamId = getTeamId(params.scope);
  const projectId = params.projectId;

  // For project-scoped keys, enforce the key's project matches the request.
  if (isProjectScope(params.scope)) {
    const scopeProjectId = getProjectId(params.scope);
    if (projectId !== scopeProjectId) {
      // Mismatch — return empty list rather than leaking existence info.
      return { rows: [], nextCursor: null };
    }
  }

  const currentFilterHash = computeFilterHash({ sourceKind: params.sourceKind });

  // Build WHERE conditions
  const conditions = [
    eq(schema.events.teamId, teamId),
    eq(schema.events.projectId, projectId),
  ];

  if (params.sourceKind) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conditions.push(eq(schema.events.kind, params.sourceKind as any));
  }

  // Cursor: decode and apply position + validate filter hash.
  if (params.cursor) {
    let cursorPayload: CursorPayload;
    try {
      const raw = JSON.parse(
        Buffer.from(params.cursor, 'base64url').toString('utf8'),
      );
      // Light validate the cursor shape without importing the full schema —
      // we validate resource/sort/filterHash here and use the position.
      if (
        typeof raw !== 'object' ||
        raw === null ||
        (raw as Record<string, unknown>)['resource'] !== 'events' ||
        (raw as Record<string, unknown>)['sort'] !== 'created_at' ||
        (raw as Record<string, unknown>)['v'] !== 1 ||
        (raw as Record<string, unknown>)['projectId'] !== projectId
      ) {
        throw new Error('cursor_invalid');
      }
      if ((raw as Record<string, unknown>)['filterHash'] !== currentFilterHash) {
        throw new Error('cursor_invalid');
      }
      const pos = (raw as Record<string, unknown>)['position'] as Record<string, unknown>;
      if (typeof pos['sortValue'] !== 'string' || typeof pos['id'] !== 'string') {
        throw new Error('cursor_invalid');
      }
      cursorPayload = raw as unknown as CursorPayload;
    } catch {
      throw new Error('cursor_invalid');
    }

    // Apply cursor pagination: (created_at < sortValue)
    // OR (created_at = sortValue AND id < id) — tie-breaker.
    const cursorSortValue = cursorPayload.position.sortValue;
    const cursorId = cursorPayload.position.id;

    conditions.push(
      or(
        lt(schema.events.createdAt, new Date(cursorSortValue)),
        and(
          eq(schema.events.createdAt, new Date(cursorSortValue)),
          lt(schema.events.id, cursorId),
        ),
      )!,
    );
  }

  // Fetch limit + 1 to detect if there's a next page.
  const rows = await db
    .select(EVENT_COLUMNS)
    .from(schema.events)
    .where(and(...conditions))
    .orderBy(sql`${schema.events.createdAt} DESC`, sql`${schema.events.id} DESC`)
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const resultRows = (hasMore ? rows.slice(0, params.limit) : rows) as unknown as EventRow[];

  let nextCursor: string | null = null;
  if (hasMore && resultRows.length > 0) {
    const lastRow = resultRows[resultRows.length - 1]!;
    const nextPayload: CursorPayload = {
      resource: 'events',
      sort: 'created_at',
      v: 1,
      projectId,
      position: {
        sortValue: lastRow.createdAt.toISOString(),
        id: lastRow.id,
      },
      filterHash: currentFilterHash,
    };
    nextCursor = encodeCursor(nextPayload);
  }

  return { rows: resultRows, nextCursor };
}

/**
 * Fetch a single event by ID within an explicit tenant/project scope.
 *
 * For all-projects scope, matches any project within the team. For project
 * scope, matches only the bound project. Returns undefined when the event
 * does not exist OR belongs to a different team (anti-enumeration: identical
 * 404 for genuinely missing and cross-team IDs).
 */
export async function getEventById(
  db: AppDb,
  scope: ScopeContext,
  projectId: string,
  eventId: string,
): Promise<EventRow | undefined> {
  const teamId = getTeamId(scope);

  const conditions = [
    eq(schema.events.id, eventId),
    eq(schema.events.teamId, teamId),
    eq(schema.events.projectId, projectId),
  ];

  // For project scope, also restrict to the key's project.
  if (isProjectScope(scope)) {
    const scopeProjectId = getProjectId(scope);
    if (projectId !== scopeProjectId) {
      return undefined;
    }
    conditions.push(eq(schema.events.projectId, scopeProjectId));
  }

  const rows = await db
    .select(EVENT_COLUMNS)
    .from(schema.events)
    .where(and(...conditions))
    .limit(1);

  return rows[0] as unknown as EventRow | undefined;
}

/**
 * Fetch events by their IDs, scoped to a specific team + project.
 *
 * Every query carries both teamId and projectId (red line 5.5). Events
 * belonging to a different team or project are never returned.
 *
 * Returns events in the order of the input `eventIds` array for
 * determinism (the caller relies on this for per-event result ordering).
 * An event id not found or not belonging to the scope is silently omitted.
 *
 * @param db       the database handle
 * @param teamId   tenant scope
 * @param projectId project scope
 * @param eventIds event ids to fetch (evt_...)
 * @returns matching events, in input order
 */
export async function getEventsByIds(
  db: AppDb,
  teamId: string,
  projectId: string,
  eventIds: readonly string[],
): Promise<EventRow[]> {
  if (eventIds.length === 0) return [];

  // Drizzle inArray requires at least one element.
  const rows = await db
    .select(EVENT_COLUMNS)
    .from(schema.events)
    .where(
      and(
        eq(schema.events.teamId, teamId),
        eq(schema.events.projectId, projectId),
        drizzleInArray(schema.events.id, eventIds as [string, ...string[]]),
      ),
    );

  // Preserve input order so the caller can correlate with its eventId list.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: EventRow[] = [];
  for (const id of eventIds) {
    const row = byId.get(id);
    if (row) ordered.push(row as unknown as EventRow);
  }
  return ordered;
}

/**
 * Insert an event idempotently within an explicit tenant/project scope.
 *
 * Idempotency identity: (projectId, channel, connectorKind, deliveryId, itemKey).
 *
 * Behavior:
 *   - No existing row → INSERT → returns `{ eventId, status: 'inserted' }`.
 *   - Existing row + same payloadHash → returns `{ eventId, status: 'duplicate' }`.
 *   - Existing row + different payloadHash → throws `IdempotencyConflictError`.
 *
 * Race condition handling: a pre-check SELECT is used as a fast path. If a
 * concurrent insert wins between the pre-check and our INSERT, the unique
 * violation on `events_idempotency_uq` is caught, the row is re-queried, and
 * the hash is compared — exactly the same logic as the sequential-replay path.
 *
 * The caller MUST have already:
 *   1. Zod-validated all inputs
 *   2. Stripped <private> tags from the payload (red line 5.3)
 *   3. Computed the payload hash over the redacted canonical JSON (N1)
 *   4. Resolved any actor → principal mapping
 *
 * @throws IdempotencyConflictError — same identity, different payload hash.
 */
export async function insertEvent(
  db: AppDb,
  req: EventInsertRequest,
): Promise<EventInsertResult> {
  // ── Fast path: check for existing row ──────────────────────────────────
  const existingRow = await findByIdentity(
    db,
    req.teamId,
    req.projectId,
    req.channel,
    req.connectorKind,
    req.deliveryId,
    req.itemKey,
  );
  if (existingRow) {
    return resolveReplay(existingRow, req.payloadHash);
  }

  // ── Insert ─────────────────────────────────────────────────────────────
  const eventId = newEventId();

  try {
    const [row] = await db
      .insert(schema.events)
      .values({
        id: eventId,
        teamId: req.teamId,
        projectId: req.projectId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: req.channel as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        kind: req.kind as any,
        connectorKind: req.connectorKind,
        sourceEvent: req.sourceEvent ?? null,
        sourceAction: req.sourceAction ?? null,
        deliveryId: req.deliveryId,
        itemKey: req.itemKey,
        externalId: req.externalId,
        url: req.url ?? null,
        actor: req.actor ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actorProvenance: req.actorProvenance as any,
        actorPrincipalId: req.actorPrincipalId ?? null,
        occurredAt: req.occurredAt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        occurredAtProvenance: req.occurredAtProvenance as any,
        ingestedByCredentialId: req.ingestedByCredentialId ?? null,
        ingestedByPrincipalId: req.ingestedByPrincipalId ?? null,
        payload: req.payload,
        payloadBytes: req.payloadBytes,
        payloadHash: req.payloadHash,
        payloadSchemaVersion: req.payloadSchemaVersion,
        envelopeVersion: req.envelopeVersion,
      })
      .returning({ id: schema.events.id });

    if (!row) {
      throw new Error('event insert returned no row');
    }

    return { eventId: row.id, status: 'inserted' };
  } catch (err) {
    if (!isUniqueViolation(err, 'events_idempotency_uq')) throw err;

    // Lost a concurrent race: someone else inserted between our pre-check
    // and our insert. Re-query and resolve exactly like the sequential path.
    const raced = await findByIdentity(
      db,
      req.teamId,
      req.projectId,
      req.channel,
      req.connectorKind,
      req.deliveryId,
      req.itemKey,
    );
    if (!raced) {
      // Constraint fired but row not visible yet — surface the original error.
      throw err;
    }
    return resolveReplay(raced, req.payloadHash);
  }
}

// ── Replay resolution ───────────────────────────────────────────────────────

/**
 * Compare the stored payload hash with the incoming one.
 *
 * Same hash → duplicate (return the original event id).
 * Different hash → throw IdempotencyConflictError (N1: never silent overwrite).
 */
function resolveReplay(
  existing: ExistingEventRow,
  incomingHash: string,
): EventInsertResult {
  if (existing.payloadHash === incomingHash) {
    return { eventId: existing.id, status: 'duplicate' };
  }
  throw new IdempotencyConflictError(
    `idempotency_conflict: event already stored with a different payload hash ` +
      `(existing: ${existing.id}, incoming hash: ${incomingHash})`,
  );
}
