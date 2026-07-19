/**
 * Principal upsert repository.
 *
 * Based on the stable provider user ID, within a tenant scope:
 *   - Creates a new principal if none exists for (team, provider, providerKind, providerUserId).
 *   - Updates display_login on conflict without changing the principal ID or kind.
 *
 * Never treats the mutable login as the identity key. The kind (human/service)
 * is set on creation and preserved on conflict — the caller must provide the
 * correct kind at first insert time.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';

export interface PrincipalUpsertRequest {
  readonly teamId: string;
  readonly provider: string;
  readonly providerKind: string;
  readonly providerUserId: string;
  readonly kind: 'human' | 'service';
  readonly displayLogin: string | null | undefined;
}

export interface PrincipalUpsertResult {
  readonly id: string;
  /** true when this call created a new principal row */
  readonly created: boolean;
  /** true when this call updated the display_login on an existing row */
  readonly updated: boolean;
}

/**
 * Upsert a principal by stable provider identity within a tenant scope.
 *
 * Returns the resolved principal id plus status flags. The `kind` is set only
 * on creation and preserved on subsequent upserts — never silently changed.
 */
export async function upsertPrincipal(
  db: AppDb,
  req: PrincipalUpsertRequest,
): Promise<PrincipalUpsertResult> {
  const provider = resolveProviderEnum(req.provider);
  const id = `pri_${randomUUID().replace(/-/g, '')}`;

  const [row] = await db
    .insert(schema.principals)
    .values({
      id,
      teamId: req.teamId,
      kind: req.kind,
      provider,
      providerKind: req.providerKind,
      providerUserId: req.providerUserId,
      displayLogin: req.displayLogin ?? null,
    })
    .onConflictDoUpdate({
      target: [
        schema.principals.teamId,
        schema.principals.provider,
        schema.principals.providerKind,
        schema.principals.providerUserId,
      ],
      set: { displayLogin: req.displayLogin ?? null },
    })
    .returning({ id: schema.principals.id });

  if (!row) {
    throw new Error('principal upsert returned no row');
  }

  // Determine created vs updated: if the generated id equals the returned id,
  // this row was freshly inserted (onConflictDoUpdate cannot change the id).
  // There is a subtle race: another concurrent upsert could win the insert
  // with a different id, and our ON CONFLICT would update that row and return
  // the OTHER id. In that case the returned id !== our generated id → updated.
  return {
    id: row.id,
    created: row.id === id,
    updated: row.id !== id,
  };
}

export interface PrincipalLookup {
  readonly id: string;
  readonly kind: 'human' | 'service';
  readonly provider: string;
  readonly providerKind: string;
  readonly providerUserId: string;
  readonly displayLogin: string | null;
}

/**
 * Look up a principal by stable provider identity within a tenant scope.
 * Returns undefined when no matching principal exists.
 */
export async function findPrincipal(
  db: AppDb,
  teamId: string,
  provider: string,
  providerKind: string,
  providerUserId: string,
): Promise<PrincipalLookup | undefined> {
  const rows = await db
    .select({
      id: schema.principals.id,
      kind: schema.principals.kind,
      provider: schema.principals.provider,
      providerKind: schema.principals.providerKind,
      providerUserId: schema.principals.providerUserId,
      displayLogin: schema.principals.displayLogin,
    })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.teamId, teamId),
        eq(schema.principals.provider, resolveProviderEnum(provider)),
        eq(schema.principals.providerKind, providerKind),
        eq(schema.principals.providerUserId, providerUserId),
      ),
    )
    .limit(1);
  return rows[0];
}

const BUILTIN_IDENTITY_PROVIDERS = new Set(['github']);

function resolveProviderEnum(provider: string): 'github' | 'external' {
  return BUILTIN_IDENTITY_PROVIDERS.has(provider) ? 'github' : 'external';
}
