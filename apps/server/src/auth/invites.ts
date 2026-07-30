/**
 * Invite Links — Generate single-use, 7-day-expiring team invitations.
 *
 * Security invariants:
 * - Invite tokens are high-entropy random strings (256-bit).
 * - Only SHA-256 hashes are stored in the database; the plaintext token
 *   is returned exactly once when the invite is created.
 * - Single-use: `used_at` is set on first acceptance; subsequent attempts
 *   with the same token are rejected with a clear "already used" error.
 * - Expired invites are rejected with a clear "expired" error.
 * - Plaintext tokens are NEVER logged, persisted in plaintext, or included
 *   in error responses beyond the "not found / expired / used" envelope.
 * - Invite acceptance creates the membership row in one database round-trip
 *   (the membership insert and invite use-marking happen atomically).
 *
 * @module invites
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { AppDb } from '../db/client.js';
import type { TeamRole } from '@teamem/schema';

// ── Constants ───────────────────────────────────────────────────────────────

/** Token entropy: 256 bits. */
const TOKEN_BYTES = 32;
/** Default invite lifetime: 7 days. */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** HMAC key for token hashing (server-side secret). */
const INVITE_HMAC_KEY = 'teamem-invite';

// ── Token handling ──────────────────────────────────────────────────────────

/**
 * Generate a high-entropy plaintext invite token.
 *
 * Format: `inv_<base64url>` where the random part is 256 bits.
 *
 * SECURITY: The returned plaintext must be returned to the caller exactly
 * once and then discarded. It must NEVER be logged, stored, or included
 * in error messages, audit records, or any persistent output.
 */
export function generateInviteToken(): string {
  const randomPart = randomBytes(TOKEN_BYTES)
    .toString('base64url')
    .replace(/=/g, '');
  return `inv_${randomPart}`;
}

/**
 * Compute the SHA-256 hash of an invite token.
 *
 * This is the value stored in the `invites.token_hash` column.
 * The original plaintext is never persisted.
 */
export function hashInviteToken(token: string): string {
  return createHmac('sha256', INVITE_HMAC_KEY).update(token, 'utf8').digest('hex');
}

// ── Database operations ─────────────────────────────────────────────────────

export interface CreatedInvite {
  /** The invite row ID (inv_...). */
  id: string;
  /** The plaintext token — shown once, never stored. */
  plaintext: string;
  /** The target role this invite grants. */
  targetRole: TeamRole;
  /** When the invite expires. */
  expiresAt: Date;
}

export interface AcceptInviteResult {
  /** The membership that was created. */
  membership: {
    userId: string;
    teamId: string;
    role: TeamRole;
  };
  /** The invite that was accepted. */
  invite: {
    id: string;
    teamId: string;
    targetRole: TeamRole;
    invitedByUserId: string;
    usedAt: Date;
  };
}

export type InviteLookupResult =
  | { status: 'valid'; invite: InviteRow }
  | { status: 'expired'; invite: InviteRow }
  | { status: 'used'; invite: InviteRow }
  | { status: 'not_found' };

interface InviteRow {
  id: string;
  teamId: string;
  targetRole: TeamRole;
  invitedByUserId: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/**
 * Create a new team invitation.
 *
 * Steps:
 * 1. Generate a high-entropy plaintext token.
 * 2. Compute SHA-256 hash.
 * 3. Insert a row into the `invites` table with the hash (never the plaintext).
 * 4. Return the invite metadata plus the ONE-TIME plaintext token.
 *
 * The caller must build the full invite link (including server base URL)
 * and return the plaintext to the admin who generated it. After that,
 * the plaintext must be discarded.
 *
 * @param db - Database client
 * @param teamId - The team the invite is for
 * @param targetRole - The role the invite grants on acceptance
 * @param invitedByUserId - The user who generated the invite
 * @param ttlMs - Optional TTL override (default: 7 days)
 * @returns The created invite metadata with the one-time plaintext token
 */
export async function createInvite(
  db: AppDb,
  teamId: string,
  targetRole: TeamRole,
  invitedByUserId: string,
  ttlMs: number = DEFAULT_INVITE_TTL_MS,
): Promise<CreatedInvite> {
  const plaintext = generateInviteToken();
  const tokenHash = hashInviteToken(plaintext);
  const inviteId = `inv_${randomBytes(12).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  await db.$client.query(
    `INSERT INTO invites (id, team_id, token_hash, target_role, invited_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [inviteId, teamId, tokenHash, targetRole, invitedByUserId, expiresAt.toISOString()],
  );

  return {
    id: inviteId,
    plaintext,
    targetRole,
    expiresAt,
  };
}

/**
 * Look up an invite by its plaintext token.
 *
 * Computes the hash of the token and looks up the invite row.
 * Returns a discriminated union so callers can handle each case
 * with appropriate error messaging (but without leaking which
 * specific condition failed to unauthenticated callers when that
 * matters).
 *
 * SECURITY: The plaintext token is used only to compute its hash;
 * it is never logged or stored.
 */
export async function lookupInviteByToken(
  db: AppDb,
  plaintext: string,
): Promise<InviteLookupResult> {
  const tokenHash = hashInviteToken(plaintext);

  const result = await db.$client.query(
    `SELECT id, team_id, target_role, invited_by_user_id, expires_at, used_at, created_at
     FROM invites
     WHERE token_hash = $1
     LIMIT 1`,
    [tokenHash],
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return { status: 'not_found' };
  }

  const invite: InviteRow = {
    id: row['id'] as string,
    teamId: row['team_id'] as string,
    targetRole: row['target_role'] as TeamRole,
    invitedByUserId: row['invited_by_user_id'] as string,
    expiresAt: row['expires_at'] as unknown as Date,
    usedAt: (row['used_at'] as Date | null) ?? null,
    createdAt: row['created_at'] as Date,
  };

  // Check used first — a used invite is terminal regardless of expiry
  if (invite.usedAt !== null) {
    return { status: 'used', invite };
  }

  // Check expiry
  if (invite.expiresAt < new Date()) {
    return { status: 'expired', invite };
  }

  return { status: 'valid', invite };
}

/**
 * Accept an invitation: validate the token, create the membership,
 * and mark the invite as used — all in a single database transaction.
 *
 * Steps (in a transaction):
 * 1. Look up the invite by token hash.
 * 2. If not found, expired, or already used → throw appropriately.
 * 3. Insert the membership row (or handle conflict if the user is
 *    already a member).
 * 4. Mark the invite as used (set used_at = now()).
 * 5. Return the membership and invite metadata.
 *
 * Atomicity: the SELECT ... FOR UPDATE locks the invite row, preventing
 * two concurrent acceptances of the same token from both succeeding.
 *
 * @param db - Database client
 * @param plaintext - The plaintext invite token from the URL
 * @param userId - The user accepting the invite
 * @returns The created membership and accepted invite metadata
 */
export async function acceptInvite(
  db: AppDb,
  plaintext: string,
  userId: string,
): Promise<AcceptInviteResult> {
  const tokenHash = hashInviteToken(plaintext);

  // Use a transaction with row-level locking to prevent double-use races.
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');

    // Lock the invite row for update — only one concurrent acceptor
    // can proceed; the other waits and then sees used_at IS NOT NULL.
    const inviteResult = await client.query(
      `SELECT id, team_id, target_role, invited_by_user_id, expires_at, used_at
       FROM invites
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );

    const row = inviteResult.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      await client.query('ROLLBACK');
      throw new InviteNotFoundError();
    }

    const inviteId = row['id'] as string;
    const teamId = row['team_id'] as string;
    const targetRole = row['target_role'] as TeamRole;
    const invitedByUserId = row['invited_by_user_id'] as string;
    const expiresAt = row['expires_at'] as unknown as Date;
    const usedAt = (row['used_at'] as Date | null) ?? null;

    // Check already used
    if (usedAt !== null) {
      await client.query('ROLLBACK');
      throw new InviteAlreadyUsedError();
    }

    // Check expired
    if (expiresAt < new Date()) {
      await client.query('ROLLBACK');
      throw new InviteExpiredError();
    }

    // Create membership. Use ON CONFLICT DO NOTHING to handle the case
    // where the user is already a member (idempotent accept — return
    // existing membership rather than failing).
    //
    // If the user already has a membership with a DIFFERENT role,
    // DO NOTHING preserves the existing role (the invite does not
    // downgrade or upgrade an existing member).
    const membershipResult = await client.query(
      `INSERT INTO memberships (user_id, team_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, team_id) DO NOTHING
       RETURNING user_id, team_id, role`,
      [userId, teamId, targetRole],
    );

    // Mark invite as used regardless of whether membership was newly
    // created or the user was already a member. The invite is single-use:
    // once someone has successfully claimed it, the token is consumed.
    const now = new Date();
    await client.query(
      `UPDATE invites SET used_at = $1 WHERE id = $2`,
      [now.toISOString(), inviteId],
    );

    await client.query('COMMIT');

    // If the user was already a member, membershipResult.rows[0] will
    // be empty (ON CONFLICT DO NOTHING returns nothing). In that case
    // fetch the existing membership.
    let membershipRole = targetRole;
    if (membershipResult.rows.length === 0) {
      const existingMembership = await db.$client.query(
        `SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2 LIMIT 1`,
        [userId, teamId],
      );
      const existingRow = existingMembership.rows[0] as Record<string, unknown> | undefined;
      if (existingRow) {
        membershipRole = existingRow['role'] as TeamRole;
      }
    }

    return {
      membership: {
        userId,
        teamId,
        role: membershipRole,
      },
      invite: {
        id: inviteId,
        teamId,
        targetRole,
        invitedByUserId,
        usedAt: now,
      },
    };
  } catch (err) {
    // If the error is one of our domain errors, rethrow it.
    if (err instanceof InviteNotFoundError ||
        err instanceof InviteAlreadyUsedError ||
        err instanceof InviteExpiredError) {
      throw err;
    }
    // For any other error, try to rollback and rethrow.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors — the connection may already be broken.
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── Domain errors ───────────────────────────────────────────────────────────

/**
 * Thrown when an invite token does not match any stored invite.
 * The caller should translate this to a generic "not found" response —
 * never reveal whether the token was malformed or genuinely missing.
 */
export class InviteNotFoundError extends Error {
  constructor() {
    super('Invite not found');
    this.name = 'InviteNotFoundError';
  }
}

/**
 * Thrown when an invite has already been used.
 * The caller should return a clear "already used" error so the user
 * understands the invite is no longer valid (this is NOT a security-
 * sensitive case — the user has the token and is entitled to know
 * it was consumed).
 */
export class InviteAlreadyUsedError extends Error {
  constructor() {
    super('Invite has already been used');
    this.name = 'InviteAlreadyUsedError';
  }
}

/**
 * Thrown when an invite has expired.
 * The caller should return a clear "expired" error so the user
 * understands they need a new invite.
 */
export class InviteExpiredError extends Error {
  constructor() {
    super('Invite has expired');
    this.name = 'InviteExpiredError';
  }
}
