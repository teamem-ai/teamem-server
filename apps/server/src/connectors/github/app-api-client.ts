/**
 * Minimal GitHub App API client (DUA-147 / M0-GH-07).
 *
 * Thin wrapper around `fetch` for GitHub's REST API. Uses the credentials
 * provider for authentication when available; falls back to unauthenticated
 * access for public repositories.
 *
 * Endpoints:
 *   - GET /repos/{owner}/{repo}/commits/{sha}/pulls
 *     Lists pull requests associated with a commit. High-confidence
 *     source for commit→PR anchoring.
 *   - GET /repos/{owner}/{repo}/pulls/{number}
 *     Full PR details including body (for issue reference extraction).
 *
 * Every API response body is Zod-validated before any field is read
 * (project red line: cross-boundary input must pass Zod). The raw
 * `response.json()` value is never cast directly to an interface.
 *
 * Error handling:
 *   - 404 → returns `null` (no association — not an error)
 *   - 401/403 → throws GitHubApiError
 *   - Rate limited (429 + Retry-After) → throws GitHubApiError
 *   - Other non-2xx → throws GitHubApiError
 *   - Zod validation failure → throws GitHubApiError with server_error code
 *
 * Credentials are never exposed in logs or error messages (§5.3).
 */

import { z } from 'zod';
import type { GitHubAppCredentialsProvider } from './app-credentials.js';

// ── Zod schemas for GitHub API responses ─────────────────────────────────────

/**
 * Schema for a single PR object returned by GET /repos/{owner}/{repo}/commits/{sha}/pulls.
 * This is a subset — GitHub returns many more fields, but we only validate
 * what we consume. `.passthrough()` lets extra fields through without error.
 */
const rawPullRequestSchema = z
  .object({
    number: z.number().int().nonnegative(),
    title: z.string(),
    state: z.string(),
    merged_at: z.string().nullable(),
    html_url: z.string(),
    head: z.object({ sha: z.string() }).passthrough(),
    base: z.object({ ref: z.string() }).passthrough(),
  })
  .passthrough();

/**
 * Schema for the full PR detail object from GET /repos/{owner}/{repo}/pulls/{number}.
 * Same base fields plus `body`.
 */
const rawPullRequestDetailSchema = z
  .object({
    number: z.number().int().nonnegative(),
    title: z.string(),
    state: z.string(),
    merged_at: z.string().nullable(),
    html_url: z.string(),
    head: z.object({ sha: z.string() }).passthrough(),
    base: z.object({ ref: z.string() }).passthrough(),
    body: z.string().nullable(),
  })
  .passthrough();

/** Schema for the array returned by GET …/commits/{sha}/pulls. */
const rawPullRequestArraySchema = z.array(z.unknown());

// ── API types (derived from Zod schemas for consumers) ───────────────────────

/** Validated PR shape from the commits/{sha}/pulls endpoint. */
export type GitHubPullRequestRef = {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  htmlUrl: string;
  headSha: string;
  baseRef: string;
};

/** Validated detailed PR shape from the pulls/{number} endpoint. */
export type GitHubPullRequestDetail = {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  htmlUrl: string;
  headSha: string;
  baseRef: string;
  body: string | null;
};

// ── Error types ──────────────────────────────────────────────────────────────

/**
 * Errors the API client deliberately surfaces. Callers can switch on `code`
 * to decide retry vs. propagate vs. treat as "no data".
 */
export class GitHubApiError extends Error {
  public readonly code: 'unauthorized' | 'not_found' | 'rate_limited' | 'server_error';
  public readonly status: number;

  constructor(
    code: GitHubApiError['code'],
    status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
    this.code = code;
    this.status = status;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Build request headers. When a credentials provider is available, use a
 * Bearer token; otherwise make an unauthenticated request (works for public
 * repos at 60 req/hour).
 */
async function buildHeaders(
  credentials: GitHubAppCredentialsProvider | null,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'teamem',
  };
  if (credentials) {
    const token = await credentials.getInstallationToken();
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface GitHubApiClient {
  getPullRequestsForCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GitHubPullRequestRef[] | null>;

  getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubPullRequestDetail | null>;
}

/**
 * Create a GitHub API client.
 *
 * @param credentials - Optional credentials provider. When absent, requests
 *   are unauthenticated (public repos only, 60 req/hour rate limit).
 * @param fetchImpl - Injectable fetch for testing.
 */
export function createGitHubApiClient(
  credentials: GitHubAppCredentialsProvider | null = null,
  fetchImpl: typeof fetch = fetch,
): GitHubApiClient {
  /**
   * Generic request helper. On 404 returns `{data: null}`, on other errors
   * throws GitHubApiError. The raw JSON body is Zod-validated before being
   * returned as `data`.
   */
  async function request(
    path: string,
  ): Promise<{ data: unknown; error: null } | { data: null; error: null }> {
    const headers = await buildHeaders(credentials);
    const url = `${GITHUB_API_BASE}${path}`;

    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers });
    } catch (err) {
      throw new GitHubApiError(
        'server_error',
        0,
        `GitHub API request failed (network): ${String(err).slice(0, 200)}`,
      );
    }

    // 404 = repo/endpoint not found; 422 = commit SHA looks invalid
    // Both mean "no data for this query" — return null so callers get
    // an empty result rather than a thrown error.
    if (response.status === 404 || response.status === 422) {
      return { data: null, error: null };
    }

    if (response.status === 401) {
      const body = await response.text().catch(() => '');
      throw new GitHubApiError(
        'unauthorized',
        response.status,
        `GitHub API returned ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    if (response.status === 403) {
      const body = await response.text().catch(() => '');
      const isRateLimit = body.toLowerCase().includes('rate limit');
      throw new GitHubApiError(
        isRateLimit ? 'rate_limited' : 'unauthorized',
        response.status,
        `GitHub API returned ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new GitHubApiError(
        'rate_limited',
        429,
        `GitHub API rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new GitHubApiError(
        'server_error',
        response.status,
        `GitHub API returned ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (err) {
      throw new GitHubApiError(
        'server_error',
        response.status,
        `GitHub API returned unparseable JSON: ${String(err).slice(0, 200)}`,
      );
    }

    return { data: rawBody, error: null };
  }

  /**
   * Parse a raw GitHub API value through a Zod schema, throwing a
   * GitHubApiError on validation failure. The error message describes which
   * fields failed but never includes raw API values (which could contain
   * tokens or sensitive content).
   */
  function validate<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
    const result = schema.safeParse(raw);
    if (!result.success) {
      const issueMessages = result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new GitHubApiError(
        'server_error',
        0,
        `GitHub API response validation failed for ${label}: ${issueMessages}`.slice(0, 300),
      );
    }
    return result.data;
  }

  return {
    async getPullRequestsForCommit(
      owner: string,
      repo: string,
      sha: string,
    ): Promise<GitHubPullRequestRef[] | null> {
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/pulls`;
      const { data, error } = await request(path);

      if (error) throw error;
      if (data === null) return null;

      // 1. Validate it's an array
      const arr = validate(rawPullRequestArraySchema, data, 'commits/{sha}/pulls (array)');

      // 2. Validate each element
      const validated: GitHubPullRequestRef[] = [];
      for (let i = 0; i < arr.length; i++) {
        const pr = validate(rawPullRequestSchema, arr[i], `commits/{sha}/pulls[${i}]`);
        validated.push(mapPullRequest(pr));
      }
      return validated;
    },

    async getPullRequest(
      owner: string,
      repo: string,
      number: number,
    ): Promise<GitHubPullRequestDetail | null> {
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(String(number))}`;
      const { data, error } = await request(path);

      if (error) throw error;
      if (data === null) return null;

      const pr = validate(rawPullRequestDetailSchema, data, `pulls/${number}`);
      return mapPullRequestDetail(pr);
    },
  };
}

// ── Mappers (raw Zod-validated shape → consumer-friendly type) ───────────────

type RawPullRequest = z.infer<typeof rawPullRequestSchema>;
type RawPullRequestDetail = z.infer<typeof rawPullRequestDetailSchema>;

/** Map a Zod-validated PR item to our typed ref. Exported for tests. */
export function mapPullRequest(raw: RawPullRequest): GitHubPullRequestRef {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    mergedAt: raw.merged_at,
    htmlUrl: raw.html_url,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
  };
}

/** Map a Zod-validated PR detail to our typed detail. Exported for tests. */
export function mapPullRequestDetail(raw: RawPullRequestDetail): GitHubPullRequestDetail {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    mergedAt: raw.merged_at,
    htmlUrl: raw.html_url,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
    body: raw.body,
  };
}

/** Zod schemas exported for tests to verify validation behavior. */
export const __test = {
  rawPullRequestSchema,
  rawPullRequestDetailSchema,
};
