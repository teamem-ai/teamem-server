/**
 * Authorization vocabulary. (Contract v0.2 Appendix A — N6/N7.)
 */
import { z } from 'zod';
import { isoDateTime, teamId } from './common.js';

/**
 * API key scopes (N7 — deliberately four, no admin scope: purge, key
 * management and configuration changes belong to web-session roles).
 * Mint-time superset rule: `read:payload` requires `read` to also be
 * granted — a key with payload access but no list access cannot exist.
 */
export const apiScope = z.enum([
  'events:write',
  'read', // concepts/jobs/event-list summaries
  'read:payload', // raw (post-strip) payload detail — every read audited
  'audit:read',
]);
export type ApiScope = z.infer<typeof apiScope>;

/**
 * Web-session roles and their capability ladder (N6). Each level includes
 * everything below it:
 * - viewer: browse concepts/jobs lists
 * - member: + search/context, concept detail
 * - admin:  + key mint/revoke, source & LLM config, audit:read, payload detail
 * - owner:  + purge, role management, team deletion
 */
export const teamRole = z.enum(['viewer', 'member', 'admin', 'owner']);
export type TeamRole = z.infer<typeof teamRole>;

// ── v0.3 additive (DUA-222): M2 auth identity DTOs ────────────────────────

export const userId = z.string().regex(/^usr_[A-Za-z0-9]+$/);
export const sessionId = z.string().regex(/^ses_[A-Za-z0-9]+$/);
export const inviteId = z.string().regex(/^inv_[A-Za-z0-9]+$/);

/**
 * A GitHub-authenticated user record. `githubId` is the stable numeric
 * identity key; `githubLogin` is mutable display-only.
 */
export const user = z.strictObject({
  id: userId,
  githubId: z.number().int().positive(),
  githubLogin: z.string().min(1),
  avatarUrl: z.string().url().nullable(),
  createdAt: isoDateTime,
});
export type User = z.infer<typeof user>;

/**
 * Team membership — binds a user to a team with a role.
 * (user, team) is unique; at most one membership per user per team.
 */
export const membership = z.strictObject({
  userId,
  teamId,
  role: teamRole,
  createdAt: isoDateTime,
});
export type Membership = z.infer<typeof membership>;

/**
 * Team invitation. Token hash is never exposed over the API — it is
 * stored internally (SHA-256) and compared on acceptance.
 */
export const invite = z.strictObject({
  id: inviteId,
  teamId,
  targetRole: teamRole,
  invitedByUserId: userId,
  expiresAt: isoDateTime,
  usedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type Invite = z.infer<typeof invite>;

/**
 * Web session record. The session token is stored as an irreversible
 * SHA-256 hash; the plaintext is returned once at login and never again.
 */
export const webSession = z.strictObject({
  id: sessionId,
  userId,
  issuedAt: isoDateTime,
  expiresAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type WebSession = z.infer<typeof webSession>;
