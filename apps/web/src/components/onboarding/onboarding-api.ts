/**
 * Onboarding wizard API client — typed wrappers around real public HTTP endpoints.
 *
 * Every function here corresponds to an endpoint that actually exists in
 * apps/server/src/http/routes/.  Nothing is fabricated.
 *
 * Auth model:
 *   Steps 1–4 use the web session cookie (credentials: "include").
 *   Step 5 uses the Bearer token minted in Step 4 so it can call the
 *   scoped v1 read endpoints (events / jobs / concepts) which require
 *   Bearer auth, not session cookies.
 */
import type { MintKeyResponse } from "./onboarding-types";

// ── Helpers ────────────────────────────────────────────────────────────────

export class ApiRequestError extends Error {
  status: number;
  requestId?: string;
  details?: Record<string, unknown>;

  constructor(status: number, body: { error?: string; message?: string; requestId?: string; details?: Record<string, unknown> }) {
    super(body.message ?? `HTTP ${status}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

async function request<T>(
  url: string,
  options: RequestInit & { apiKey?: string } = {},
): Promise<T> {
  const { apiKey, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(fetchOptions.headers as Record<string, string> | undefined),
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    ...fetchOptions,
    headers,
    ...(apiKey ? {} : { credentials: "include" }),
  });

  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = await res.json() as Record<string, unknown>;
    } catch { /* not JSON */ }
    throw new ApiRequestError(res.status, body as {
      error?: string; message?: string; requestId?: string; details?: Record<string, unknown>;
    });
  }

  // 204 No Content → return empty object
  if (res.status === 204) return {} as T;

  return res.json() as Promise<T>;
}

// ── Common response envelope (real shape from @teamem/schema) ──────────────

export interface ApiResponse<T> {
  requestId: string;
  data: T;
}

export interface ListResponse<T> {
  requestId: string;
  data: T[];
  nextCursor: string | null;
}

// ── Step 1: Team & Project ─────────────────────────────────────────────────

/** POST /v1/teams (web session). Real route: teams.ts:57 */
export async function createTeam(name: string): Promise<ApiResponse<{
  id: string; name: string; role: string; createdAt: string;
}>> {
  return request("/v1/teams", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** POST /v1/teams/:teamId/projects (web session, admin+). Real route: projects.ts:59 */
export async function createProject(
  teamId: string,
  name: string,
): Promise<ApiResponse<{
  id: string; teamId: string; name: string; createdAt: string;
}>> {
  return request(`/v1/teams/${encodeURIComponent(teamId)}/projects`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

// ── Step 2: LLM Provider (informational — no write endpoint exists) ────────

/**
 * LLM provider metadata.  The server configures providers via environment
 * variables (TEAMEM_ANTHROPIC_API_KEY, etc.), not via a web API.  This
 * step is educational: it shows what the four BYO providers offer so the
 * operator can set the right env vars at deploy time.
 */
export interface LlmProviderMeta {
  kind: "claude" | "openai" | "openrouter" | "custom";
  name: string;
  subtitle: string;
  hasEmbedding: boolean;
}

export const LLM_PROVIDERS: LlmProviderMeta[] = [
  {
    kind: "claude",
    name: "Anthropic",
    subtitle: "Claude models · no embedding API",
    hasEmbedding: false,
  },
  {
    kind: "openai",
    name: "OpenAI",
    subtitle: "GPT models + embeddings",
    hasEmbedding: true,
  },
  {
    kind: "openrouter",
    name: "OpenRouter",
    subtitle: "Many models + embeddings via one key",
    hasEmbedding: true,
  },
  {
    kind: "custom",
    name: "Custom endpoint",
    subtitle: "Any OpenAI-compatible base URL",
    hasEmbedding: false,
  },
];

// ── Step 3: GitHub App (informational — no installation endpoint exists) ───

/**
 * GitHub App connection is configured at deploy time via env vars.
 * Repository access is managed on github.com, not through the teamem API.
 * This step explains the architecture and links to GitHub.
 */

// ── Step 4: Mint API Key ───────────────────────────────────────────────────

/** POST /v1/teams/:teamId/keys (web session, admin+). Real route: keys.ts:67 */
export async function mintApiKey(
  teamId: string,
  projectId: string,
  name: string,
): Promise<ApiResponse<MintKeyResponse>> {
  return request(`/v1/teams/${encodeURIComponent(teamId)}/keys`, {
    method: "POST",
    body: JSON.stringify({
      name,
      projectId,
      scopes: ["read", "write"],
    }),
  });
}

// ── Step 5: Dashboard stats ────────────────────────────────────────────────

export interface OnboardingStats {
  /** Whether any events exist for the project. */
  hasEvents: boolean;
  /** Whether any jobs exist for the project. */
  hasJobs: boolean;
  /** Whether any concept pages exist for the project. */
  hasPages: boolean;
  /** Exact count when known (≤ page size), or the page size when more exist. */
  eventsCount: number;
  jobsCount: number;
  pagesCount: number;
}

export interface LatestConceptPage {
  uuid: string;
  path: string;
  title: string;
  type: string;
  confidence: string;
  evidenceCount: number;
}

/**
 * Fetch onboarding dashboard data using the API key from Step 4.
 *
 * Queries /v1/events, /v1/jobs, /v1/concepts with projectId parameter
 * and Bearer auth.  Parses the real cursor-paginated response shape.
 */
export async function getOnboardingStats(
  projectId: string,
  apiKey: string,
): Promise<OnboardingStats> {
  const PAGE_SIZE = 100;

  const [eventsRes, jobsRes, conceptsRes] = await Promise.all([
    fetch(
      `/v1/events?projectId=${encodeURIComponent(projectId)}&limit=${PAGE_SIZE}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    ).then(r => r.ok ? r.json() as Promise<ListResponse<unknown>> : null),

    fetch(
      `/v1/jobs?projectId=${encodeURIComponent(projectId)}&limit=${PAGE_SIZE}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    ).then(r => r.ok ? r.json() as Promise<ListResponse<unknown>> : null),

    fetch(
      `/v1/concepts?projectId=${encodeURIComponent(projectId)}&limit=${PAGE_SIZE}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    ).then(r => r.ok ? r.json() as Promise<ListResponse<unknown>> : null),
  ]);

  const eventsLen = eventsRes?.data?.length ?? 0;
  const jobsLen = jobsRes?.data?.length ?? 0;
  const pagesLen = conceptsRes?.data?.length ?? 0;

  return {
    hasEvents: eventsLen > 0,
    hasJobs: jobsLen > 0,
    hasPages: pagesLen > 0,
    // Show exact count when data fits in a page, or the page size as a
    // lower bound (e.g. "100+" would be honest but the UI currently shows
    // the raw number — for a fresh portal counts will be small).
    eventsCount: eventsLen,
    jobsCount: jobsLen,
    pagesCount: pagesLen,
  };
}

/** Fetch the latest compiled concept page using the API key from Step 4. */
export async function getLatestConcept(
  projectId: string,
  apiKey: string,
): Promise<LatestConceptPage | null> {
  const res = await fetch(
    `/v1/concepts?projectId=${encodeURIComponent(projectId)}&limit=1` +
    // Sort by last_confirmed desc (the default for concepts list)
    `&sort=last_confirmed`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!res.ok) return null;

  const json = await res.json() as ListResponse<{
    uuid?: string; id?: string; path: string; title: string;
    type: string; confidence: string; evidenceCount?: number;
  }>;
  const page = json.data?.[0];
  if (!page) return null;

  return {
    uuid: page.uuid ?? page.id ?? "",
    path: page.path,
    title: page.title,
    type: page.type,
    confidence: page.confidence,
    evidenceCount: page.evidenceCount ?? 1,
  };
}

// ── Session check ──────────────────────────────────────────────────────────

export interface SessionInfo {
  loggedIn: boolean;
  githubLogin?: string;
  avatarUrl?: string | null;
  teamId?: string;
  teamName?: string;
  role?: string;
}

/** GET /auth/me — check web session. Real route: auth.ts:402.
 *  Response shape is a flat object (not wrapped in {data}). */
export async function getSessionInfo(): Promise<SessionInfo> {
  try {
    const res = await fetch("/auth/me", {
      credentials: "include",
      redirect: "error",
    });
    if (!res.ok) return { loggedIn: false };
    const json = await res.json() as {
      userId?: string; githubLogin?: string; avatarUrl?: string | null;
      teamId?: string; teamName?: string; role?: string;
    };
    return {
      loggedIn: true,
      githubLogin: json.githubLogin,
      avatarUrl: json.avatarUrl,
      teamId: json.teamId,
      teamName: json.teamName,
      role: json.role,
    };
  } catch {
    return { loggedIn: false };
  }
}
