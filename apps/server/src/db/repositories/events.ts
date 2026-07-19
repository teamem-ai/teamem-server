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
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';

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
