/**
 * Thin API client for the teamem portal.
 *
 * Communicates with the server exclusively over public HTTP endpoints.
 * Never imports server-internal code or connects to the database.
 *
 * All cross-boundary response shapes are validated with Zod schemas from
 * @teamem/schema.  A parse failure here means the server violated the
 * contract — it is surfaced as an error, never silently swallowed.
 */
import { inviteLookupResponse } from "@teamem/schema";
import type { InviteLookupStatus } from "@teamem/schema";

// ── Types (derived from the shared contract, not hand-written) ───────────

/** Returned by GET /auth/me when the user has a valid session. */
export interface SessionUser {
  userId: string;
  githubLogin: string;
  avatarUrl: string | null;
  teamId: string | null;
  teamName: string | null;
  role: string | null;
}

/** Returned by GET /auth/github/status */
export interface GitHubStatus {
  configured: boolean;
}

/** Status of an invite lookup. Mirrors the schema enum. */
export type { InviteLookupStatus };

/**
 * Response shape from GET /invites/:token.
 * Derived from the shared Zod schema — never hand-written.
 */
export type InviteLookup = ReturnType<typeof inviteLookupResponse.parse>;

// ── Session ──────────────────────────────────────────────────────────────

/**
 * Fetch the current web session, if any.
 * Returns null for 401 (not logged in), throws for other errors.
 */
export async function getSession(): Promise<SessionUser | null> {
  const res = await fetch("/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/auth/me returned ${res.status}`);
  return res.json() as Promise<SessionUser>;
}

// ── GitHub status ────────────────────────────────────────────────────────

/**
 * Check whether the GitHub OAuth App is configured on the server.
 */
export async function getGitHubStatus(): Promise<GitHubStatus> {
  const res = await fetch("/auth/github/status");
  if (!res.ok) throw new Error(`/auth/github/status returned ${res.status}`);
  return res.json() as Promise<GitHubStatus>;
}

// ── Invite lookup ────────────────────────────────────────────────────────

/**
 * Look up an invite by its plaintext token.
 * Validates the response against the shared Zod schema before returning.
 * On 404, returns a schema-conforming not_found object (never an empty
 * object that would violate the contract).
 */
export async function lookupInvite(token: string): Promise<InviteLookup> {
  const res = await fetch(`/invites/${encodeURIComponent(token)}`);

  if (res.status === 404) {
    // Return a schema-conforming not_found response instead of an empty
    // object. The Zod schema requires `invite` to be a complete object.
    return inviteLookupResponse.parse({
      status: "not_found",
      invite: {
        id: "inv_unknown",
        teamId: "unknown",
        teamName: null,
        targetRole: "member",
        invitedByLogin: null,
        invitedByRole: null,
        expiresAt: new Date(0).toISOString(),
        usedAt: null,
      },
    });
  }

  if (!res.ok) throw new Error(`/invites/:token returned ${res.status}`);

  const body: unknown = await res.json();
  return inviteLookupResponse.parse(body);
}

// ── Invite acceptance ────────────────────────────────────────────────────

/**
 * Accept an invite. Requires an active web session.
 *
 * Calls POST /teams/:teamId/invites/accept with the token.
 */
export async function acceptInvite(
  teamId: string,
  token: string,
): Promise<{ membership: { role: string }; invite: { id: string } }> {
  const res = await fetch(
    `/teams/${encodeURIComponent(teamId)}/invites/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    const errObj = (body as Record<string, unknown>)?.error as
      | Record<string, unknown>
      | undefined;
    const msg = errObj?.message as string | undefined;
    throw new Error(msg ?? `Accept invite failed (${res.status})`);
  }
  return res.json();
}
