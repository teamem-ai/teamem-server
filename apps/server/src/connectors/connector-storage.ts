/**
 * Generic connector persistence seam (DUA-129).
 *
 * Bridges the connector producer contract (`registry.ts`'s `NormalizedEvent`
 * — open `connectorKind`/`eventKind` strings, no schema/migration required
 * for a new private connector) onto the storage projection of
 * @teamem/schema's closed `source_channel`/`source_kind` enums:
 *
 *   - Built-in connectors (github/cli/mcp) keep their own channel value and
 *     must already emit an `eventKind` matching a closed `source_kind`.
 *   - Any other (private) connector lands in the generic 'external' channel
 *     bucket with kind='external_event'; its true identity is preserved
 *     verbatim in `events.connector_kind` / `principals.provider_kind"
 *     (v0.3 additive columns, see db/schema.ts) so two different private
 *     connectors sharing that bucket can never collide on delivery ID or
 *     provider user ID.
 *
 * Out of scope here (owned by the ingestion-pipeline task): the
 * receive -> Zod validate -> stripPrivateTags -> persist -> enqueue pipeline
 * (5.3). Callers MUST pass an already-redacted `payload` — this module does
 * not strip `<private>` content itself, it only stores what it is given and
 * computes the frozen N1 payload hash over the (assumed-redacted) content.
 */
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  sourceKind as sourceKindSchema,
  PAYLOAD_SCHEMA_VERSION,
  EVENT_ENVELOPE_VERSION,
  type SourceKind,
} from '@teamem/schema';
import * as schema from '../db/schema.js';
import type { AppDb } from '../db/client.js';
import { normalizedEventSchema, type NormalizedActor, type NormalizedEvent } from './registry.js';

const BUILTIN_CONNECTOR_KINDS = new Set(['github', 'cli', 'mcp']);
const BUILTIN_IDENTITY_PROVIDERS = new Set(['github']);

type BuiltinChannel = 'github' | 'cli' | 'mcp';
type StoredChannel = BuiltinChannel | 'external';
type StoredKind = SourceKind;

/** Explicit scope every connector-storage write must carry (red line 5.5). */
export interface ConnectorScope {
  readonly teamId: string;
  readonly projectId: string;
}

export class InvalidNormalizedEventError extends Error {}

/** Same identity, different payload — N1: 409 idempotency_conflict, never a silent overwrite. */
export class IdempotencyConflictError extends Error {}

function isBuiltinConnectorKind(kind: string): kind is BuiltinChannel {
  return BUILTIN_CONNECTOR_KINDS.has(kind);
}

/** Built-ins keep their own channel; anything else is the generic bucket. */
function resolveChannel(connectorKind: string): StoredChannel {
  return isBuiltinConnectorKind(connectorKind) ? connectorKind : 'external';
}

/**
 * Built-in connectors must already emit a closed-vocabulary eventKind; a
 * private connector always collapses to the generic 'external_event' bucket
 * (its real eventKind is preserved verbatim — see resolveSourceEvent below).
 */
function resolveKind(channel: StoredChannel, eventKind: string): StoredKind {
  if (channel === 'external') return 'external_event';
  const parsed = sourceKindSchema.safeParse(eventKind);
  if (!parsed.success || parsed.data === 'external_event') {
    throw new InvalidNormalizedEventError(
      `built-in connector channel '${channel}' produced an eventKind ('${eventKind}') ` +
        'that is not a known source_kind value',
    );
  }
  return parsed.data;
}

/**
 * Fidelity guarantee for the open eventKind: built-ins keep whatever raw
 * sourceEvent the connector supplied (Q6, may be absent); external-channel
 * events always retain their real eventKind, falling back to it when the
 * connector didn't separately populate a raw sourceEvent.
 */
function resolveSourceEvent(channel: StoredChannel, event: NormalizedEvent): string | null {
  if (channel === 'external') return event.sourceEvent ?? event.eventKind;
  return event.sourceEvent ?? null;
}

function resolveProviderEnum(provider: string): 'github' | 'external' {
  return BUILTIN_IDENTITY_PROVIDERS.has(provider) ? 'github' : 'external';
}

/** Canonical JSON per N1: sorted object keys, recursively, no whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, '')}`;
}

function newPrincipalId(): string {
  return `pri_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Resolves an existing principal for this raw actor claim or creates one.
 * Always preserves the real open provider string in provider_kind, even for
 * providers outside the built-in identity_provider enum (v0.3 additive,
 * DUA-129) — never fabricates a principal, never drops the claim (5.4).
 */
export async function resolveOrCreatePrincipal(
  db: AppDb,
  scope: ConnectorScope,
  actor: NormalizedActor,
): Promise<string> {
  const provider = resolveProviderEnum(actor.provider);

  const inserted = await db
    .insert(schema.principals)
    .values({
      id: newPrincipalId(),
      teamId: scope.teamId,
      kind: actor.kind,
      provider,
      providerKind: actor.provider,
      providerUserId: actor.providerUserId,
      displayLogin: actor.displayLogin ?? null,
    })
    .onConflictDoNothing({
      target: [
        schema.principals.teamId,
        schema.principals.provider,
        schema.principals.providerKind,
        schema.principals.providerUserId,
      ],
    })
    .returning({ id: schema.principals.id });

  const insertedRow = inserted[0];
  if (insertedRow) return insertedRow.id;

  const existing = await db
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.teamId, scope.teamId),
        eq(schema.principals.provider, provider),
        eq(schema.principals.providerKind, actor.provider),
        eq(schema.principals.providerUserId, actor.providerUserId),
      ),
    )
    .limit(1);

  const existingRow = existing[0];
  if (!existingRow) {
    throw new Error(
      'principal resolution race: insert conflicted but no matching row was found',
    );
  }
  return existingRow.id;
}

export interface PersistNormalizedEventResult {
  readonly eventId: string;
  readonly channel: StoredChannel;
  readonly connectorKind: string;
  readonly principalId: string | null;
  /** true when this call replayed an existing identity+hash match (N1) — no new row was written. */
  readonly duplicate: boolean;
}

/**
 * Persists one NormalizedEvent under explicit tenant/project scope,
 * preserving connector identity through to the idempotency constraint
 * (events_idempotency_uq now includes connector_kind — see db/schema.ts).
 *
 * Cross-boundary validation (project rule — every boundary input goes
 * through Zod): `event`/`event.actor` are runtime-checked against
 * `registry.ts`'s schemas, not just typed, since a connector package is
 * untrusted from the storage layer's point of view.
 *
 * Idempotent replay (N1): same identity + same payload hash returns the
 * original result (`duplicate: true`, no new row, no recompute-as-error);
 * same identity + different hash throws IdempotencyConflictError. The
 * pre-check is not itself atomic with the insert — a genuine concurrent
 * race still falls through to the unique constraint, which remains the
 * backstop (that raw path is exercised by connector-storage.integration.test.ts).
 */
export async function persistNormalizedEvent(
  db: AppDb,
  scope: ConnectorScope,
  event: NormalizedEvent,
): Promise<PersistNormalizedEventResult> {
  const parsed = normalizedEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new InvalidNormalizedEventError(
      `invalid NormalizedEvent: ${z.prettifyError(parsed.error)}`,
    );
  }
  const validEvent = parsed.data;

  const channel = resolveChannel(validEvent.connectorKind);
  const kind = resolveKind(channel, validEvent.eventKind);
  const sourceEvent = resolveSourceEvent(channel, validEvent);

  const payloadBytes = Buffer.byteLength(JSON.stringify(validEvent.payload), 'utf8');
  const payloadHash = createHash('sha256')
    .update(canonicalJson(validEvent.payload))
    .digest('hex');

  const existing = await db
    .select({
      id: schema.events.id,
      payloadHash: schema.events.payloadHash,
      actorPrincipalId: schema.events.actorPrincipalId,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.projectId, scope.projectId),
        eq(schema.events.channel, channel),
        eq(schema.events.connectorKind, validEvent.connectorKind),
        eq(schema.events.deliveryId, validEvent.deliveryId),
        eq(schema.events.itemKey, validEvent.itemKey),
      ),
    )
    .limit(1);

  const existingRow = existing[0];
  if (existingRow) {
    if (existingRow.payloadHash === payloadHash) {
      return {
        eventId: existingRow.id,
        channel,
        connectorKind: validEvent.connectorKind,
        principalId: existingRow.actorPrincipalId,
        duplicate: true,
      };
    }
    throw new IdempotencyConflictError(
      `idempotency_conflict: project '${scope.projectId}' channel '${channel}' ` +
        `connectorKind '${validEvent.connectorKind}' delivery '${validEvent.deliveryId}' ` +
        `item '${validEvent.itemKey}' already stored with a different payload hash`,
    );
  }

  const principalId = validEvent.actor
    ? await resolveOrCreatePrincipal(db, scope, validEvent.actor)
    : null;

  const [row] = await db
    .insert(schema.events)
    .values({
      id: newEventId(),
      teamId: scope.teamId,
      projectId: scope.projectId,
      channel,
      kind,
      connectorKind: validEvent.connectorKind,
      sourceEvent,
      sourceAction: validEvent.sourceAction ?? null,
      deliveryId: validEvent.deliveryId,
      itemKey: validEvent.itemKey,
      externalId: validEvent.externalId,
      url: validEvent.url ?? null,
      actor: validEvent.actor, // raw claim, preserved verbatim (5.4) — never fabricated
      actorProvenance: validEvent.actorProvenance,
      actorPrincipalId: principalId,
      occurredAt: new Date(validEvent.occurredAt),
      occurredAtProvenance: validEvent.occurredAtProvenance,
      ingestedByCredentialId: null, // filled by the ingestion layer (out of scope)
      ingestedByPrincipalId: null,
      payload: validEvent.payload,
      payloadBytes,
      payloadHash,
      payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
      envelopeVersion: EVENT_ENVELOPE_VERSION,
    })
    .returning({ id: schema.events.id });

  if (!row) {
    throw new Error('event insert returned no row');
  }

  return {
    eventId: row.id,
    channel,
    connectorKind: validEvent.connectorKind,
    principalId,
    duplicate: false,
  };
}
