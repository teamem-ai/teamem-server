/**
 * Thin API client for the teamem portal.
 *
 * Communicates with the server exclusively over public HTTP endpoints.
 * Never imports server-internal code or connects to the database.
 */

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

/** Returned by GET /invites/:token */
export interface InviteLookup {
  status: "valid" | "expired" | "used" | "not_found";
  invite: {
    id: string;
    teamId: string;
    teamName: string | null;
    targetRole: string;
    invitedByLogin: string | null;
    invitedByRole: string | null;
    expiresAt: string;
    usedAt: string | null;
  };
}

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

/**
 * Check whether the GitHub OAuth App is configured on the server.
 */
export async function getGitHubStatus(): Promise<GitHubStatus> {
  const res = await fetch("/auth/github/status");
  if (!res.ok) throw new Error(`/auth/github/status returned ${res.status}`);
  return res.json() as Promise<GitHubStatus>;
}

/**
 * Look up an invite by its plaintext token.
 * Returns the invite details including team name, role, and inviter.
 */
export async function lookupInvite(token: string): Promise<InviteLookup> {
  const res = await fetch(`/invites/${encodeURIComponent(token)}`);
  if (res.status === 404) {
    return { status: "not_found", invite: {} as InviteLookup["invite"] };
  }
  if (!res.ok) throw new Error(`/invites/:token returned ${res.status}`);
  return res.json() as Promise<InviteLookup>;
}

/**
 * Accept an invite. Requires an active web session.
 *
 * Calls POST /teams/:teamId/invites/accept with the token.
 */
export async function acceptInvite(
  teamId: string,
  token: string,
): Promise<{ membership: { role: string }; invite: { id: string } }> {
  const res = await fetch(`/teams/${encodeURIComponent(teamId)}/invites/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    const errObj = (body as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
    const msg = errObj?.message as string | undefined;
    throw new Error(msg ?? `Accept invite failed (${res.status})`);
  }
  return res.json();
}
