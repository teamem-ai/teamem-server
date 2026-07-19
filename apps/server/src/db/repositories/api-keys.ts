/**
 * API Key Auth Repository (DUA-174).
 *
 * Resolves a token hash into a fully-scoped authentication context:
 * credential (api_keys row), principal snapshot, team identity, and a
 * tagged ScopeContext that downstream queries must carry (red line 5.5).
 *
 * Security invariants:
 * - Unknown and revoked tokens produce the same generic error; the system
 *   never reveals which condition was met (no information leakage).
 * - read:payload implies read is enforced at the database level (N7
 *   CHECK constraint) and verified here as a defense-in-depth assertion.
 * - The returned ScopeContext is the ONLY scope downstream code should
 *   use — never construct a scope from user-supplied team/project IDs
 *   when an API key scope is available.
 */
import { eq, and, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { apiScope, type ApiScope } from '@teamem/schema';
import * as schema from '../../db/schema.js';
import type { AppDb } from '../../db/client.js';
import type { ScopeContext } from '../../auth/scope.js';
import { projectScope, allProjectsScope } from '../../auth/scope.js';

// ── Error types ─────────────────────────────────────────────────────────────

/**
 * Thrown when a token hash does not match any active (non-revoked) key.
 *
 * The error message is deliberately generic — callers must NOT distinguish
 * between "unknown token" and "revoked token" to avoid information leakage.
 */
export class AuthenticationError extends Error {
  readonly name = 'AuthenticationError';
}

// ── Return types ────────────────────────────────────────────────────────────

export interface PrincipalSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly provider: string;
  readonly providerKind: string;
  readonly providerUserId: string;
  readonly displayLogin: string | null;
}

export interface TeamSnapshot {
  readonly id: string;
  readonly name: string;
}

export interface AuthContext {
  /** The api_keys row ID (key_...). This is the credential identifier, NOT the token. */
  readonly credentialId: string;
  /** Human-readable key name. */
  readonly keyName: string;
  /** Granted scopes — a subset of the four ApiScope values. */
  readonly scopes: readonly ApiScope[];
  /** The tagged ScopeContext for downstream scoped queries (red line 5.5). */
  readonly scope: ScopeContext;
  /** Snapshot of the principal bound to this key (may be null if key has no principal). */
  readonly principal: PrincipalSnapshot | null;
  /** Snapshot of the team this key belongs to. */
  readonly team: TeamSnapshot;
  /** When the key was created. */
  readonly createdAt: Date;
}

// ── Main resolution function ────────────────────────────────────────────────

/**
 * Resolve a token hash into a fully-scoped AuthContext.
 *
 * Steps:
 * 1. Look up the api_keys row by token_hash where revoked_at IS NULL.
 * 2. If not found, throw AuthenticationError (covers both unknown and revoked).
 * 3. JOIN to teams for the team snapshot.
 * 4. Optionally JOIN to principals for the principal snapshot.
 * 5. Construct the tagged ScopeContext from the key's allProjects/projectId.
 * 6. Defense-in-depth: verify read:payload implies read at the app level.
 *
 * @param db - The Drizzle database instance
 * @param tokenHash - SHA-256 hex hash of the plaintext token
 * @returns AuthContext with credential, scope, principal, and team snapshots
 * @throws AuthenticationError for unknown or revoked tokens
 */
export async function resolveTokenHash(
  db: AppDb,
  tokenHash: string,
): Promise<AuthContext> {
  // Step 1: Look up the api_keys row by token_hash, filtering out revoked keys.
  // SECURITY: Unknown and revoked tokens hit the same code path — no information leakage.
  const keyRows = await db
    .select({
      id: schema.apiKeys.id,
      teamId: schema.apiKeys.teamId,
      projectId: schema.apiKeys.projectId,
      principalId: schema.apiKeys.principalId,
      name: schema.apiKeys.name,
      scopes: schema.apiKeys.scopes,
      allProjects: schema.apiKeys.allProjects,
      createdAt: schema.apiKeys.createdAt,
    })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.tokenHash, tokenHash), isNull(schema.apiKeys.revokedAt)))
    .limit(1);

  const keyRow = keyRows[0];

  // No match (unknown or revoked — SQL filters both) — same error, same message (no information leakage)
  if (!keyRow) {
    throw new AuthenticationError('invalid or revoked API key');
  }

  // Step 2: Fetch team snapshot (always present — FK enforced).
  const teamRows = await db
    .select({
      id: schema.teams.id,
      name: schema.teams.name,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, keyRow.teamId))
    .limit(1);

  const teamRow = teamRows[0];
  if (!teamRow) {
    throw new AuthenticationError('invalid or revoked API key');
  }

  // Step 3: Fetch principal snapshot (optional — key may have no principal bound).
  let principal: PrincipalSnapshot | null = null;
  if (keyRow.principalId) {
    const principalRows = await db
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
          eq(schema.principals.teamId, keyRow.teamId),
          eq(schema.principals.id, keyRow.principalId),
        ),
      )
      .limit(1);

    const principalRow = principalRows[0];
    if (principalRow) {
      principal = {
        id: principalRow.id,
        kind: principalRow.kind,
        provider: principalRow.provider,
        providerKind: principalRow.providerKind,
        providerUserId: principalRow.providerUserId,
        displayLogin: principalRow.displayLogin,
      };
    }
  }

  // Step 4: Construct the tagged ScopeContext from the key's binding.
  let scope: ScopeContext;
  if (keyRow.allProjects) {
    scope = allProjectsScope(keyRow.teamId);
  } else {
    // N6 database invariant guarantees projectId is NOT NULL when allProjects=false,
    // but we assert defensively at the application layer.
    if (!keyRow.projectId) {
      throw new AuthenticationError('invalid or revoked API key');
    }
    scope = projectScope(keyRow.teamId, keyRow.projectId);
  }

  // Step 5: Validate scopes against the frozen Zod enum (defense-in-depth).
  // The DB CHECK constraint is the primary guarantee; this catches logic errors at the
  // app boundary before anything downstream consumes potentially invalid data.
  const parsedScopes = z.array(apiScope).safeParse(keyRow.scopes);
  if (!parsedScopes.success) {
    throw new AuthenticationError('invalid or revoked API key');
  }
  const scopes = parsedScopes.data;

  // Defense-in-depth: verify the N7 invariant at the application layer.
  if (scopes.includes('read:payload') && !scopes.includes('read')) {
    throw new AuthenticationError('invalid or revoked API key');
  }

  return {
    credentialId: keyRow.id,
    keyName: keyRow.name,
    scopes,
    scope,
    principal,
    team: {
      id: teamRow.id,
      name: teamRow.name,
    },
    createdAt: keyRow.createdAt,
  };
}

// ── Last-used update ────────────────────────────────────────────────────────

/**
 * Update the last_used_at timestamp for a key. Called after successful
 * authentication to track key usage. Updates are best-effort; a failure
 * here must not block the authenticated request.
 *
 * @param db - The Drizzle database instance
 * @param credentialId - The api_keys row ID (key_...)
 */
export async function touchKeyLastUsed(
  db: AppDb,
  credentialId: string,
): Promise<void> {
  await db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, credentialId));
}
