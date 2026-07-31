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
 */
import type {
  ConceptSummary,
  Concept,
  SearchResponse,
  ContextResponse,
  ProjectEntry,
  EventDetail,
} from "@teamem/schema";

const BASE = "/v1";

/** Thrown on non-2xx API responses with a parsed error envelope. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      body = await res.json();
    } catch {
      // ignore parse failures
    }
    throw new ApiError(
      res.status,
      body.error?.code ?? "unknown",
      body.error?.message ?? `HTTP ${res.status}`,
      body.error?.details,
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
  return request<SessionInfo>("/auth/me");
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

// ── Events (itemResponse envelope) ─────────────────────────────────────────

export async function fetchEvent(eventId: string, projectId: string): Promise<EventDetail> {
  const resp = await get<{ requestId: string; data: EventDetail }>(
    `/events/${eventId}`,
    { projectId },
  );
  return resp.data;
}
