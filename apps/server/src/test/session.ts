/**
 * Test helper for creating web sessions and session cookies.
 *
 * Mirrors the server-side session creation logic without requiring the
 * OAuth flow. Use only in integration tests.
 */
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';

const SESSION_HMAC_KEY = 'teamem-session';

export interface TestSession {
  userId: string;
  sessionId: string;
  token: string;
  cookieHeader: string;
}

/** Generate a session token and its SHA-256 hash for testing. */
export function generateSessionToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(48).toString('base64url');
  const hash = createHmac('sha256', SESSION_HMAC_KEY)
    .update(plaintext)
    .digest('hex');
  return { plaintext, hash };
}

/**
 * Create a user, team membership, and web session in one transaction.
 *
 * Returns the plaintext session token and a Cookie header value.
 */
export async function createTestSession(
  db: AppDb,
  {
    teamId,
    role = 'owner',
    login = 'test-user',
    skipMembership = false,
  }: {
    teamId: string;
    role?: string;
    login?: string;
    skipMembership?: boolean;
  },
): Promise<TestSession> {
  const userId = `usr_${randomBytes(16).toString('hex')}`;
  const sessionId = `ses_${randomBytes(16).toString('hex')}`;
  // github_id is an integer column; stay inside the signed 32-bit range.
  const githubId = randomInt(1_000_000, 2_147_483_647);
  const { plaintext, hash } = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO users (id, github_id, github_login, avatar_url, created_at)
          VALUES (${userId}, ${githubId}, ${login}, ${`https://avatars.githubusercontent.com/u/${githubId}`}, ${now})`,
    );
    if (!skipMembership) {
      await tx.execute(
        sql`INSERT INTO memberships (user_id, team_id, role, created_at)
            VALUES (${userId}, ${teamId}, ${role}, ${now})`,
      );
    }
    await tx.execute(
      sql`INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at, revoked_at)
          VALUES (${sessionId}, ${userId}, ${hash}, ${now}, ${expiresAt}, NULL)`,
    );
  });

  return {
    userId,
    sessionId,
    token: plaintext,
    cookieHeader: `teamem_session=${plaintext}`,
  };
}

/** Delete the test user and all related rows. */
export async function deleteTestSession(
  db: AppDb,
  userId: string,
): Promise<void> {
  await db.execute(
    sql`DELETE FROM web_sessions WHERE user_id = ${userId}`,
  );
  await db.execute(
    sql`DELETE FROM memberships WHERE user_id = ${userId}`,
  );
  await db.execute(
    sql`DELETE FROM users WHERE id = ${userId}`,
  );
}
