/**
 * Onboarding wizard API client — typed wrappers around public HTTP endpoints.
 *
 * The wizard consumes only the public REST API; it never imports server
 * internals or connects to the database directly. When a backend endpoint
 * is not yet available, the function signature and return type are declared
 * so the UI can be wired later without changing the step component contract.
 *
 * DTO shapes mirror @teamem/schema types without importing them directly
 * (the web app does not depend on the server-side schema package).
 */

// ── Response DTOs (mirror @teamem/schema shapes) ───────────────────────────

export interface CreateTeamResponse {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
  createdAt: string;
}

export interface ProjectEntry {
  id: string;
  teamId: string;
  name: string;
  createdAt: string;
}

export interface MintKeyResponse {
  id: string;
  name: string;
  token: string;
  mcpCommand: string;
  scopes: string[];
  allProjects: boolean;
  projectId: string | null;
  createdAt: string;
}

// ── Error envelope (matches @teamem/schema error shape) ─────────────────────

export interface ApiError {
  error: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  status: number;
  requestId?: string;
  details?: Record<string, unknown>;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.name = "ApiRequestError";
    this.status = status;
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function request<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    credentials: "include", // session cookie
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });

  if (!res.ok) {
    let body: ApiError;
    try {
      body = await res.json();
    } catch {
      body = {
        error: "unknown",
        message: `HTTP ${res.status}: ${res.statusText}`,
      };
    }
    throw new ApiRequestError(res.status, body);
  }

  return res.json() as Promise<T>;
}

interface ApiResponse<T> {
  requestId: string;
  data: T;
}

// ── Step 1: Team & Project ─────────────────────────────────────────────────

/** Create a new team. The session user becomes owner. */
export async function createTeam(name: string): Promise<CreateTeamResponse> {
  const res = await request<ApiResponse<CreateTeamResponse>>("/v1/teams", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return res.data;
}

/** Create a project within a team. Requires admin+ in that team. */
export async function createProject(
  teamId: string,
  name: string,
): Promise<ProjectEntry> {
  const res = await request<ApiResponse<ProjectEntry>>(
    `/v1/teams/${encodeURIComponent(teamId)}/projects`,
    {
      method: "POST",
      body: JSON.stringify({ name }),
    },
  );
  return res.data;
}

// ── Step 2: LLM Provider ───────────────────────────────────────────────────

export type LlmProviderKind =
  | "claude"
  | "openai"
  | "openrouter"
  | "custom";

export interface LlmConfigData {
  kind: LlmProviderKind;
  apiKey: string;
  baseUrl?: string; // required when kind === 'custom'
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  hasEmbedding: boolean;
  error?: string;
}

/**
 * Save LLM provider configuration.
 *
 * POST /v1/teams/:teamId/llm
 *
 * Note: this endpoint may not exist yet at the server. The UI is designed
 * to consume it when available; until then, the step UI renders correctly
 * but the save action will fail with a descriptive error.
 */
export async function saveLlmConfig(
  teamId: string,
  config: LlmConfigData,
): Promise<void> {
  await request(`/v1/teams/${encodeURIComponent(teamId)}/llm`, {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

/**
 * Test an LLM provider connection before saving.
 *
 * POST /v1/teams/:teamId/llm/test
 */
export async function testLlmConnection(
  teamId: string,
  config: LlmConfigData,
): Promise<TestConnectionResult> {
  const res = await request<ApiResponse<TestConnectionResult>>(
    `/v1/teams/${encodeURIComponent(teamId)}/llm/test`,
    {
      method: "POST",
      body: JSON.stringify(config),
    },
  );
  return res.data;
}

// ── Step 3: Repositories ───────────────────────────────────────────────────

export interface GitHubInstallationRepo {
  fullName: string; // e.g. "acme/web-app"
  events: string[]; // e.g. ["push", "pull_request", "issues"]
}

export interface GitHubInstallationStatus {
  appName: string;
  authorized: boolean;
  webhookSecretConfigured: boolean;
  repos: GitHubInstallationRepo[];
  manageUrl: string; // link to GitHub installation page
}

/**
 * Get the GitHub App installation status and repository list for the team.
 *
 * GET /v1/teams/:teamId/github-installation
 *
 * Note: this endpoint may not exist yet at the server.
 */
export async function getGitHubInstallation(
  teamId: string,
): Promise<GitHubInstallationStatus> {
  const res = await request<ApiResponse<GitHubInstallationStatus>>(
    `/v1/teams/${encodeURIComponent(teamId)}/github-installation`,
  );
  return res.data;
}

// ── Step 4: Mint API Key ───────────────────────────────────────────────────

/** Mint a project-scoped API key. Returns the one-time plaintext token. */
export async function mintApiKey(
  teamId: string,
  projectId: string,
  name: string,
): Promise<MintKeyResponse> {
  const res = await request<ApiResponse<MintKeyResponse>>(
    `/v1/teams/${encodeURIComponent(teamId)}/keys`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        projectId,
        scopes: ["read", "write"],
      }),
    },
  );
  return res.data;
}

// ── Step 5: Dashboard stats ────────────────────────────────────────────────

export interface OnboardingStats {
  eventsReceived: number;
  jobsRunning: number;
  pagesCompiled: number;
}

export interface LatestConceptPage {
  uuid: string;
  path: string;
  title: string;
  type: string; // ConceptType
  confidence: string;
  evidenceCount: number;
}

/**
 * Fetch the onboarding dashboard stats for a project.
 *
 * Combines counts from events, jobs, and concepts endpoints.
 */
export async function getOnboardingStats(
  projectId: string,
): Promise<OnboardingStats> {
  // Fetch counts from individual endpoints.
  // Each returns paginated lists; we only need the total counts or
  // we can use the response metadata if available.
  const [eventsRes, jobsRes, conceptsRes] = await Promise.all([
    fetch(`/v1/events?project=${encodeURIComponent(projectId)}&limit=1`, {
      credentials: "include",
    }).then((r) => r.json()),
    fetch(`/v1/jobs?project=${encodeURIComponent(projectId)}&limit=1`, {
      credentials: "include",
    }).then((r) => r.json()),
    fetch(`/v1/concepts?project=${encodeURIComponent(projectId)}&limit=1`, {
      credentials: "include",
    }).then((r) => r.json()),
  ]);

  // Extract counts from cursor-based pagination metadata or fall back to
  // the length of the returned data array if total isn't surfaced yet.
  const eventsReceived =
    eventsRes.total ??
    eventsRes.data?.length ??
    0;
  const jobsRunning =
    jobsRes.total ??
    jobsRes.data?.length ??
    0;
  const pagesCompiled =
    conceptsRes.total ??
    conceptsRes.data?.length ??
    0;

  return { eventsReceived, jobsRunning, pagesCompiled };
}

/** Fetch the latest compiled concept page for a project. */
export async function getLatestConcept(
  projectId: string,
): Promise<LatestConceptPage | null> {
  const res = await fetch(
    `/v1/concepts?project=${encodeURIComponent(projectId)}&limit=1&sort=last_confirmed`,
    { credentials: "include" },
  );
  if (!res.ok) return null;
  const json = await res.json();
  const data = json.data;
  if (!data || data.length === 0) return null;
  const page = data[0];
  return {
    uuid: page.uuid ?? page.id,
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
}

/** Check if the user has a valid web session. */
export async function getSessionInfo(): Promise<SessionInfo> {
  try {
    const res = await fetch("/auth/me", {
      credentials: "include",
      redirect: "error",
    });
    if (!res.ok) return { loggedIn: false };
    const json = await res.json();
    return {
      loggedIn: true,
      githubLogin: json.data?.githubLogin,
      avatarUrl: json.data?.avatarUrl,
    };
  } catch {
    return { loggedIn: false };
  }
}
