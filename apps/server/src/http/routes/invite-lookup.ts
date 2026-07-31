/**
 * Invite lookup handler — public endpoint for inspecting an invite by token.
 *
 * Extracted from app.ts so the handler can be unit-tested against a mock
 * database (following the same pattern as auth.ts / auth.test.ts). Both
 * app.ts and the test file import the identical implementation, guaranteeing
 * that a changed SQL query, renamed field, or altered status branch is
 * caught by the test suite.
 *
 * Security invariants:
 *   - Unknown/malformed tokens → 404 (identical to genuinely missing)
 *   - Plaintext token NEVER appears in the response
 *   - No authentication required — the token itself is the secret
 *
 * @module invite-lookup
 */
import type { Context } from "hono";
import type { AppDb } from "../../db/client.js";
import { lookupInviteByToken } from "../../auth/invites.js";
import { inviteLookupResponse } from "@teamem/schema";
import { InvalidRequestError, NotFoundError, InternalError } from "../errors.js";

/**
 * Handler for GET /invites/:token.
 *
 * Looks up an invite by its plaintext token, enriches the response with
 * the team name and inviter identity (login + role from memberships), and
 * returns a structured JSON response that the invite acceptance page can
 * render before the user commits to joining.
 */
export async function inviteLookupHandler(
  c: Context,
  db: AppDb,
): Promise<Response> {
  const token = c.req.param("token");
  if (!token || token.length === 0) {
    throw new InvalidRequestError("token is required");
  }
  if (!token.startsWith("inv_")) {
    throw new NotFoundError();
  }

  const lookupResult = await lookupInviteByToken(db, token);
  if (lookupResult.status === "not_found") {
    throw new NotFoundError();
  }

  const { invite } = lookupResult;

  // Look up team name
  let teamName: string | null = null;
  const teamResult = await db.$client.query(
    `SELECT name FROM teams WHERE id = $1 LIMIT 1`,
    [invite.teamId],
  );
  const teamRow = teamResult.rows[0] as Record<string, unknown> | undefined;
  teamName = (teamRow?.["name"] as string) ?? null;

  // Look up inviter login and role
  let inviterLogin: string | null = null;
  let inviterRole: string | null = null;
  const userResult = await db.$client.query(
    `SELECT github_login FROM users WHERE id = $1 LIMIT 1`,
    [invite.invitedByUserId],
  );
  const userRow = userResult.rows[0] as Record<string, unknown> | undefined;
  inviterLogin = (userRow?.["github_login"] as string) ?? null;

  // Look up inviter's role within the target team
  if (inviterLogin) {
    const roleResult = await db.$client.query(
      `SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2 LIMIT 1`,
      [invite.invitedByUserId, invite.teamId],
    );
    const roleRow = roleResult.rows[0] as Record<string, unknown> | undefined;
    inviterRole = (roleRow?.["role"] as string) ?? null;
  }

  // Normalize dates to ISO 8601 strings with millisecond precision — the
  // Zod schema (isoDateTime) rejects raw Date objects.
  const toIso = (d: Date | string | null): string | null => {
    if (d === null || d === undefined) return null;
    if (d instanceof Date) return d.toISOString();
    // Already a string — ensure it parses as a date (pass-through)
    return d;
  };

  const payload = {
    status: lookupResult.status,
    invite: {
      id: invite.id,
      teamId: invite.teamId,
      teamName,
      targetRole: invite.targetRole,
      invitedByLogin: inviterLogin,
      invitedByRole: inviterRole,
      expiresAt: toIso(invite.expiresAt),
      usedAt: toIso(invite.usedAt as Date | null),
    },
  };

  // Validate against the contract DTO before shipping — a mismatch here
  // is a server bug (wrong field name, invalid enum, etc.), not a client
  // mistake.
  const parsed = inviteLookupResponse.safeParse(payload);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: "invite_lookup_response_validation_failed",
        errors: parsed.error.flatten(),
      }),
    );
    throw new InternalError("invite lookup response validation failed");
  }

  return c.json(parsed.data);
}
