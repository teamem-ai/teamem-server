/**
 * API client — thin fetch wrapper for teamem HTTP API.
 *
 * All requests carry session cookies automatically (SameSite=Lax).
 * Errors are normalized into a stable ApiError shape.
 * Never imports server internals; only communicates via public HTTP API.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type Role = "owner" | "admin" | "member" | "viewer";

export interface MemberEntry {
  userId: string;
  githubLogin: string;
  avatarUrl: string | null;
  role: Role;
  joinedAt: string;
  principalId: string | null;
  principalDisplayLogin: string | null;
}

export interface CurrentUser {
  userId: string;
  githubLogin: string;
  avatarUrl: string | null;
  teamId: string | null;
  teamName: string | null;
  role: Role | null;
}

export interface InviteResponse {
  id: string;
  inviteLink: string;
  targetRole: Role;
  expiresAt: string;
}

export interface RoleChangeResponse {
  userId: string;
  role: Role;
  githubLogin: string;
}

export interface RemoveResponse {
  removed: boolean;
  userId: string;
  githubLogin: string;
}

export interface ConceptSummary {
  uuid: string;
  path: string;
  type: "decision" | "gotcha" | "convention" | "runbook" | "service" | "concept";
  status: "active" | "superseded" | "disputed" | "needs-review";
  confidence: "high" | "medium" | "low";
  title: string;
  tags: string[];
  lastConfirmed: string;
}

export interface ConceptListResponse {
  requestId: string;
  data: ConceptSummary[];
  nextCursor: string | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// ── Error class ────────────────────────────────────────────────────────────

export class ApiRequestError extends Error {
  status: number;
  apiError: ApiError | null;

  constructor(status: number, apiError: ApiError | null, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.apiError = apiError;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) {
    return undefined as T;
  }

  let json: Record<string, unknown> | undefined;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ApiRequestError(res.status, null, `Unexpected response (${res.status})`);
  }

  if (!res.ok) {
    const errorBody = (json.error ?? json) as ApiError | undefined;
    throw new ApiRequestError(
      res.status,
      errorBody ?? null,
      (errorBody?.message) ?? `Request failed with status ${res.status}`,
    );
  }

  return json as T;
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  return handleResponse<T>(res);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Get the current authenticated user + team membership. */
export async function fetchCurrentUser(): Promise<CurrentUser> {
  return apiFetch<CurrentUser>("/auth/me");
}

/** List all team members (requires web session). */
export async function fetchMembers(): Promise<MemberEntry[]> {
  const json = await apiFetch<{ data: MemberEntry[] }>("/v1/members");
  return json.data;
}

/** Change a member's role (owner only). */
export async function changeMemberRole(
  userId: string,
  role: Role,
): Promise<RoleChangeResponse> {
  return apiFetch<RoleChangeResponse>(`/v1/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

/** Remove a member from the team (owner only). */
export async function removeMember(userId: string): Promise<RemoveResponse> {
  return apiFetch<RemoveResponse>(`/v1/members/${userId}`, {
    method: "DELETE",
  });
}

/** Generate an invite link (admin+). */
export async function createInvite(
  teamId: string,
  targetRole: Role,
): Promise<InviteResponse> {
  return apiFetch<InviteResponse>(`/teams/${teamId}/invites`, {
    method: "POST",
    body: JSON.stringify({ targetRole }),
  });
}

/** List concepts contributed by a member (session-based, scoped to project). */
export async function fetchMemberConcepts(
  userId: string,
  projectId: string,
  limit = 20,
): Promise<ConceptListResponse> {
  const qs = new URLSearchParams({ projectId, limit: String(limit) }).toString();
  return apiFetch<ConceptListResponse>(`/v1/members/${userId}/concepts?${qs}`);
}
