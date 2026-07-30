/**
 * Invite routes — generate (admin+) and accept (any authenticated user)
 * team invitation links.
 *
 * All routes require a valid web session. Role checks use the existing
 * RBAC middleware stack:
 *
 *   POST /teams/:teamId/invites         — admin+ generates an invite link
 *   POST /teams/:teamId/invites/accept  — authenticated user accepts an invite
 *
 * Security:
 * - Only admin+ (admin/owner) can generate invites.
 * - Invite tokens are stored as SHA-256 hashes; the plaintext is returned
 *   exactly once in the generate response.
 * - Expired or already-used invites return clear error states so the user
 *   can understand why their link doesn't work (these are NOT security-
 *   sensitive — the person already possesses the token).
 * - Unknown/malformed tokens return a generic "not found" error that is
 *   indistinguishable from a genuinely missing invite.
 * - Plaintext tokens are NEVER logged, stored in audit records, or
 *   returned in any response after the initial generation.
 *
 * @module invites-routes
 */
import { Hono, type Context } from 'hono';
import type { AppDb } from '../../db/client.js';
import {
  createInvite,
  acceptInvite,
  lookupInviteByToken,
  InviteNotFoundError,
  InviteAlreadyUsedError,
  InviteExpiredError,
} from '../../auth/invites.js';
import {
  requireWebSession,
  requireTeamMembership,
  getWebSession,
  getSessionUser,
} from '../session.js';
import { requireRole } from '../../auth/rbac.js';
import {
  InvalidRequestError,
  NotFoundError,
  ConflictError,
} from '../errors.js';

// ── Route handlers ──────────────────────────────────────────────────────────

/**
 * Build the invite routes Hono instance.
 *
 * Dependencies are injected via the factory parameter. The returned
 * instance can be mounted into the main app.
 *
 * The serverBaseUrl is used to construct the full invite link in the
 * generate response (e.g. `https://example.com/join?token=inv_...`).
 */
export function buildInvitesRoutes(
  db: AppDb,
  serverBaseUrl: string,
): Hono {
  const routes = new Hono();

  // ── POST /teams/:teamId/invites ───────────────────────────────────────
  // Generate a new invitation link. Requires admin+ role.
  //
  // Request body (JSON):
  //   { targetRole: 'viewer' | 'member' | 'admin' | 'owner' }
  //
  // Response (200):
  //   { id, inviteLink, targetRole, expiresAt }
  //
  // The plaintext token is embedded in the inviteLink URL and is
  // NEVER stored in plaintext or returned again.
  routes.post(
    '/teams/:teamId/invites',
    requireWebSession(db),
    requireTeamMembership(db),
    requireRole('admin'),
    async (c: Context) => {
      const webSession = getWebSession(c);

      // Parse request body
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new InvalidRequestError('Invalid JSON body');
      }

      if (typeof body !== 'object' || body === null) {
        throw new InvalidRequestError('Request body must be a JSON object');
      }

      const { targetRole } = body as Record<string, unknown>;

      // Validate targetRole against the frozen teamRole enum
      const validRoles = ['viewer', 'member', 'admin', 'owner'];
      if (typeof targetRole !== 'string' || !validRoles.includes(targetRole)) {
        throw new InvalidRequestError(
          `targetRole must be one of: ${validRoles.join(', ')}`,
          { targetRole: typeof targetRole === 'string' ? targetRole : String(targetRole) },
        );
      }

      // Only owner can invite as owner; admin can invite up to admin.
      // This is enforced by the role ladder: admins can't escalate to owner
      // even though they can generate invites.
      if (targetRole === 'owner' && webSession.teamRole !== 'owner') {
        throw new InvalidRequestError(
          'Only owners can invite users as owners',
        );
      }

      const invite = await createInvite(
        db,
        webSession.scope.teamId,
        targetRole as 'viewer' | 'member' | 'admin' | 'owner',
        webSession.userId,
      );

      // Build the invite link — this is the only place the plaintext
      // token is ever returned.
      const inviteLink = `${serverBaseUrl}/join?token=${encodeURIComponent(invite.plaintext)}`;

      // Log invite creation (no token — only metadata)
      console.info(
        JSON.stringify({
          event: 'invite_created',
          inviteId: invite.id,
          teamId: webSession.scope.teamId,
          targetRole: invite.targetRole,
          invitedByUserId: webSession.userId,
          expiresAt: invite.expiresAt.toISOString(),
        }),
      );

      return c.json({
        id: invite.id,
        inviteLink,
        targetRole: invite.targetRole,
        expiresAt: invite.expiresAt.toISOString(),
      }, 201);
    },
  );

  // ── POST /teams/:teamId/invites/accept ────────────────────────────────
  // Accept an invitation using a token provided in the request body.
  // The accepting user must be authenticated (valid web session) but
  // does NOT need to already be a member of the target team.
  //
  // Request body (JSON):
  //   { token: 'inv_...' }
  //
  // Response (200):
  //   { membership: { userId, teamId, role }, invite: { id, teamId, ... } }
  //
  // Error responses:
  //   400 — missing/malformed token
  //   404 — unknown token (same as genuinely missing invite)
  //   409 — invite already used
  //   410 — invite expired (note: we use 410 Gone for expired resources)
  //
  // Note: This endpoint does NOT require team membership. The user is
  // joining the team — they don't have membership yet. Only the web
  // session is required.
  routes.post(
    '/teams/:teamId/invites/accept',
    requireWebSession(db),
    async (c: Context) => {
      const sessionUser = getSessionUser(c);

      // Parse request body
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new InvalidRequestError('Invalid JSON body');
      }

      if (typeof body !== 'object' || body === null) {
        throw new InvalidRequestError('Request body must be a JSON object');
      }

      const { token } = body as Record<string, unknown>;

      if (typeof token !== 'string' || token.length === 0) {
        throw new InvalidRequestError('token is required');
      }

      // Basic format validation
      if (!token.startsWith('inv_')) {
        throw new InvalidRequestError('Invalid token format');
      }

      // First, look up the invite without taking a lock to determine
      // what error to return. The actual acceptance uses FOR UPDATE
      // locking for race-condition safety.
      const lookupResult = await lookupInviteByToken(db, token);

      if (lookupResult.status === 'not_found') {
        // Unknown token — return 404 (identical to genuinely missing
        // invite, so attackers can't probe for valid tokens).
        throw new NotFoundError();
      }

      if (lookupResult.status === 'used') {
        // Already used — return 409 Conflict with a clear message.
        // This is NOT security-sensitive: the person already has the
        // token and is entitled to know it was consumed.
        throw new ConflictError('This invite link has already been used');
      }

      if (lookupResult.status === 'expired') {
        // Expired — return 410 Gone with a clear message.
        // Same reasoning as "used": the bearer of the token can know
        // why their link doesn't work.
        throw new ConflictError('This invite link has expired');
      }

      // Accept the invite (with row-level locking)
      let result: Awaited<ReturnType<typeof acceptInvite>>;
      try {
        result = await acceptInvite(db, token, sessionUser.userId);
      } catch (err) {
        if (err instanceof InviteNotFoundError) {
          throw new NotFoundError();
        }
        if (err instanceof InviteAlreadyUsedError) {
          throw new ConflictError('This invite link has already been used');
        }
        if (err instanceof InviteExpiredError) {
          throw new ConflictError('This invite link has expired');
        }
        throw err;
      }

      // Log acceptance (no token)
      console.info(
        JSON.stringify({
          event: 'invite_accepted',
          inviteId: result.invite.id,
          teamId: result.invite.teamId,
          acceptedByUserId: sessionUser.userId,
          targetRole: result.invite.targetRole,
          membershipRole: result.membership.role,
        }),
      );

      return c.json({
        membership: {
          userId: result.membership.userId,
          teamId: result.membership.teamId,
          role: result.membership.role,
        },
        invite: {
          id: result.invite.id,
          teamId: result.invite.teamId,
          targetRole: result.invite.targetRole,
        },
      }, 200);
    },
  );

  return routes;
}
