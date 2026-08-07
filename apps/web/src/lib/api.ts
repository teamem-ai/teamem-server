/**
 * Public HTTP API client for the teamem portal.
 * All data access goes through the public REST API — never imports server internals.
 *
 * Envelope shapes (packages/schema/src/common.ts — N3):
 *   - listResponse:   { requestId, data: T[], nextCursor }
 *   - itemResponse:   { requestId, data: T }
 *   - searchResponse: { requestId, results, degraded, nextCursor }  (flat, no data wrapper)
 *   - contextResponse:{ requestId, data: { markdown, ... } }
 *
 * Auth model: the browser carries the web session cookie. Governance
 * endpoints (/auth/me, /v1/teams/mine, /v1/teams/:id/projects) accept it.
 * Data-plane endpoints (/v1/concepts, /v1/search, /v1/context) currently
 * require a Bearer API key — when the server does not accept the session,
 * they return 401 and the UI surfaces that honestly (no fake data).
 *
 * Cross-boundary response shapes for session/invite flows below are
 * validated with Zod schemas from @teamem/schema where available. A parse
 * failure means the server violated the contract — it is surfaced as an
 * error, never silently swallowed.
 */
import { inviteLookupResponse } from "@teamem/schema";
import type {
  ConceptSummary,
  Concept,
  SearchResponse,
  ContextResponse,
  ProjectEntry,
  EventDetail,
  EventSummary,
  Job,
  JobEventResult,
  JobStatus,
  JobInitiator,
  KeyEntry,
} from "@teamem/schema";

export type {
  Actor,
  ActorProvenance,
  OccurredAtProvenance,
  ConceptSummary,
} from "@teamem/schema";
export type { Source, SourceKind, SourceChannel } from "@teamem/schema";

const BASE = "/v1";

interface ErrorEnvelope {
  requestId?: string;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

/** Thrown on non-2xx API responses with a parsed error envelope. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

/**
 * Audit write failed → the server refuses to return the payload.
 * This is the fail-closed lock state on event detail pages.
 */
export class AuditWriteFailedError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(status, code, message, details, requestId);
    this.name = "AuditWriteFailedError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  if (!res.ok) {
    let body: ErrorEnvelope = {};
    try {
      body = (await res.json()) as ErrorEnvelope;
    } catch {
      // ignore parse failures
    }

    // Detect fail-closed audit state: 500 + details.audit_failed === true.
    const isAuditFailed =
      res.status === 500 &&
      (body.error?.details?.audit_failed === true ||
        body.error?.details?.audit_failed === "true");
    if (isAuditFailed) {
      throw new AuditWriteFailedError(
        res.status,
        body.error?.code ?? "internal",
        body.error?.message ?? "Internal error",
        body.error?.details,
        body.requestId,
      );
    }

    throw new ApiError(
      res.status,
      body.error?.code ?? "unknown",
      body.error?.message ?? `HTTP ${res.status}`,
      body.error?.details,
      body.requestId,
    );
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  return request<T>(url.toString());
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Thin wrapper for endpoints that are NOT under /v1 (e.g. /auth/me, /teams/:id/invites).
async function rawRequest<T>(url: string, init?: RequestInit): Promise<T> {
  return request<T>(url, init);
}

// ── Session / scope (web-session authenticated) ────────────────────────────

/** GET /auth/me response (flat, no envelope — see apps/server auth routes). */
export interface SessionInfo {
  userId: string;
  githubLogin: string;
  avatarUrl: string | null;
  teamId: string;
  teamName: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export async function fetchMe(): Promise<SessionInfo> {
  return rawRequest<SessionInfo>("/auth/me");
}

/** GET /v1/teams/:teamId/projects — listResponse envelope. */
export async function fetchProjects(teamId: string): Promise<ProjectEntry[]> {
  const resp = await get<{ requestId: string; data: ProjectEntry[] }>(
    `/teams/${teamId}/projects`,
  );
  return resp.data;
}

// ── Concepts (listResponse / itemResponse envelopes) ───────────────────────

export interface ConceptListParams {
  projectId: string;
  type?: string;
  status?: string;
  tag?: string;
  contributor?: string;
  cursor?: string;
  limit?: number;
}

/** Matches schema listResponse(conceptSummary). */
export interface ConceptListResponse {
  requestId: string;
  data: ConceptSummary[];
  nextCursor: string | null;
}

export async function fetchConcepts(params: ConceptListParams): Promise<ConceptListResponse> {
  const q: Record<string, string | undefined> = {
    projectId: params.projectId,
    type: params.type,
    status: params.status,
    tag: params.tag,
    contributor: params.contributor,
    cursor: params.cursor,
    limit: String(params.limit ?? 20),
  };
  return get("/concepts", q);
}

/** Matches schema itemResponse(concept) — unwraps .data for the caller. */
export async function fetchConcept(uuid: string, projectId: string): Promise<Concept> {
  const resp = await get<{ requestId: string; data: Concept }>(
    `/concepts/${uuid}`,
    { projectId },
  );
  return resp.data;
}

// ── Search (flat searchResponse — no data wrapper) ─────────────────────────

export interface SearchParams {
  projectId: string;
  query: string;
  type?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

export async function searchConcepts(params: SearchParams): Promise<SearchResponse> {
  return post("/search", {
    projectId: params.projectId,
    query: params.query,
    type: params.type,
    status: params.status,
    cursor: params.cursor,
    limit: params.limit ?? 20,
  });
}

// ── Context (contextResponse envelope) ─────────────────────────────────────

export async function fetchContext(projectId: string): Promise<ContextResponse> {
  return get("/context", { projectId });
}

// ── Events (listResponse / itemResponse envelopes) ─────────────────────────

export interface EventListParams {
  projectId: string;
  sourceKind?: string;
  cursor?: string;
  limit?: number;
}

interface ListEnvelope<T> {
  requestId: string;
  data: T[];
  nextCursor: string | null;
}

interface ItemEnvelope<T> {
  requestId: string;
  data: T;
}

export async function fetchEvents(
  params: EventListParams,
): Promise<ListEnvelope<EventSummary>> {
  const q: Record<string, string | undefined> = {
    projectId: params.projectId,
    sourceKind: params.sourceKind,
    cursor: params.cursor,
    limit: String(params.limit ?? 20),
  };
  return get<ListEnvelope<EventSummary>>("/events", q);
}

export async function fetchEventDetail(
  eventId: string,
  projectId: string,
): Promise<ItemEnvelope<EventDetail>> {
  return get<ItemEnvelope<EventDetail>>(
    `/events/${encodeURIComponent(eventId)}`,
    { projectId },
  );
}

// ── Jobs (listResponse / itemResponse envelopes) ─────────────────────────────

export interface JobListParams {
  projectId: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

export async function fetchJobs(
  params: JobListParams,
): Promise<ListEnvelope<Job>> {
  const q: Record<string, string | undefined> = {
    projectId: params.projectId,
    status: params.status,
    cursor: params.cursor,
    limit: String(params.limit ?? 20),
  };
  return get<ListEnvelope<Job>>("/jobs", q);
}

export async function fetchJobDetail(
  jobId: string,
  projectId: string,
): Promise<ItemEnvelope<Job>> {
  return get<ItemEnvelope<Job>>(
    `/jobs/${encodeURIComponent(jobId)}`,
    { projectId },
  );
}

/** Re-run a failed compile job. Admin+ only — the server enforces this too. */
export async function retryJob(
  jobId: string,
  projectId: string,
): Promise<{ id: string; status: JobStatus }> {
  const res = await post<{ requestId: string; data: { id: string; status: JobStatus } }>(
    `/jobs/${encodeURIComponent(jobId)}/retry`,
    { projectId },
  );
  return res.data;
}

export type { Job, JobEventResult, JobStatus, JobInitiator };

// ── Session (used by login/invite flows, distinct from fetchMe: returns
//    null on 401 instead of throwing, since "not logged in" is an expected
//    state on the login page rather than an error) ──────────────────────────

/** Returned by GET /auth/me when the user has a valid session. */
export interface SessionUser {
  userId: string;
  githubLogin: string;
  avatarUrl: string | null;
  teamId: string | null;
  teamName: string | null;
  role: string | null;
}

/**
 * Fetch the current web session, if any.
 * Returns null for 401 (not logged in), throws for other errors.
 */
export async function getSession(): Promise<SessionUser | null> {
  const res = await fetch("/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/auth/me returned ${res.status}`);
  return (await res.json()) as SessionUser;
}

// ── GitHub OAuth status ──────────────────────────────────────────────────

export interface GitHubStatus {
  configured: boolean;
}

/**
 * Check whether the GitHub OAuth App is configured on the server.
 */
export async function getGitHubStatus(): Promise<GitHubStatus> {
  const res = await fetch("/auth/github/status");
  if (!res.ok) throw new Error(`/auth/github/status returned ${res.status}`);
  return res.json() as Promise<GitHubStatus>;
}

// ── Invite lookup ────────────────────────────────────────────────────────

/** Status of a found invite. Re-exported from the shared schema. */
export type { InviteFoundStatus } from "@teamem/schema";

/**
 * Response shape from GET /invites/:token.
 * Derived from the shared Zod schema — never hand-written.
 */
export type InviteLookup = ReturnType<typeof inviteLookupResponse.parse>;

/**
 * Look up an invite by its plaintext token.
 *
 * Cross-boundary response validation:
 *   - HTTP 404 (malformed / unknown token) → not_found branch, no fake
 *     invite object is fabricated.
 *   - HTTP 200 → validated against the shared Zod schema. A parse failure
 *     means the server violated the contract and is surfaced as an error.
 */
export async function lookupInvite(token: string): Promise<InviteLookup> {
  const res = await fetch(`/invites/${encodeURIComponent(token)}`);

  if (res.status === 404) {
    return { status: "not_found" };
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

// ═══════════════════════════════════════════════════════════════════════════════
// Members & Roles (DUA-236) — session-authenticated, not under /v1
// ═══════════════════════════════════════════════════════════════════════════════

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

/** List all team members (requires web session). */
export async function fetchMembers(): Promise<MemberEntry[]> {
  const json = await rawRequest<{ data: MemberEntry[] }>("/v1/members");
  return json.data;
}

/** List API keys for the current team (requires web session, admin+).
 *  Server returns the standard listResponse envelope ({requestId, data,
 *  nextCursor}) — must unwrap .data, same as fetchProjects below. Using
 *  rawRequest directly here (as this used to) silently assigns the whole
 *  envelope object to a variable typed KeyEntry[], which compiles fine
 *  (the cast is unchecked) but crashes at runtime the first time a caller
 *  iterates it: "TypeError: ... is not iterable". */
export async function fetchKeys(teamId: string): Promise<KeyEntry[]> {
  const resp = await rawRequest<{ requestId: string; data: KeyEntry[] }>(
    `/v1/teams/${encodeURIComponent(teamId)}/keys`,
  );
  return resp.data;
}

/** Change a member's role (owner only). */
export async function changeMemberRole(
  userId: string,
  role: Role,
): Promise<RoleChangeResponse> {
  return rawRequest<RoleChangeResponse>(`/v1/members/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

/** Remove a member from the team (owner only). */
export async function removeMember(userId: string): Promise<RemoveResponse> {
  return rawRequest<RemoveResponse>(`/v1/members/${userId}`, {
    method: "DELETE",
  });
}

/** Generate an invite link (admin+). */
export async function createInvite(
  teamId: string,
  targetRole: Role,
): Promise<InviteResponse> {
  return rawRequest<InviteResponse>(`/teams/${teamId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  return rawRequest<ConceptListResponse>(`/v1/members/${userId}/concepts?${qs}`);
}
