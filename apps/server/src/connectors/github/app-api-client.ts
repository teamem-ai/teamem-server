/**
 * Minimal GitHub App API client (DUA-147 / M0-GH-07).
 *
 * Thin wrapper around `fetch` for GitHub's REST API. Uses the credentials
 * provider for authentication. Only implements the endpoints the anchor
 * resolver needs — deliberately minimal, not a general-purpose GitHub client.
 *
 * Endpoints:
 *   - GET /repos/{owner}/{repo}/commits/{sha}/pulls
 *     Lists pull requests associated with a commit. This is the high-confidence
 *     source for commit→PR anchoring.
 *
 * Error handling:
 *   - 404 → returns `null` (no association — not an error)
 *   - 401/403 → throws (configuration or permission problem)
 *   - Rate limited (429 + Retry-After) → throws after logging
 *   - Other non-2xx → throws
 *
 * Credentials are never exposed in logs or error messages (§5.3).
 */

import type { GitHubAppCredentialsProvider } from './app-credentials.js';

// ── API types ────────────────────────────────────────────────────────────────

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Minimal PR shape returned by the commits/{sha}/pulls endpoint.
 * GitHub returns a list of PR objects; we only extract the fields the
 * anchor resolver needs.
 */
export interface GitHubPullRequestRef {
  /** PR number (per-repo, stable). */
  number: number;
  /** PR title. */
  title: string;
  /** PR state: "open", "closed". */
  state: string;
  /** Whether the PR was merged. */
  mergedAt: string | null;
  /** The PR's HTML URL. */
  htmlUrl: string;
  /** The head commit SHA of the PR. */
  headSha: string;
  /** The base branch ref. */
  baseRef: string;
}

/** Raw shape from GitHub API (subset we consume). */
interface RawPullRequest {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  html_url: string;
  head: { sha: string };
  base: { ref: string };
}

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

// ── Client ───────────────────────────────────────────────────────────────────

export interface GitHubApiClient {
  /**
   * List pull requests associated with a commit.
   *
   * Uses GitHub's `GET /repos/{owner}/{repo}/commits/{sha}/pulls` endpoint.
   * This is the canonical, high-confidence association — GitHub returns only
   * PRs that actually contain this commit in their merge/head history.
   *
   * Returns an empty array when the commit is not associated with any PR
   * (the API returns 200 with `[]`). Returns null when the commit or repo
   * is not found (404).
   *
   * Throws `GitHubApiError` on auth, permission, or rate-limit failures.
   */
  getPullRequestsForCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GitHubPullRequestRef[] | null>;
}

export function createGitHubApiClient(
  credentials: GitHubAppCredentialsProvider,
  fetchImpl: typeof fetch = fetch,
): GitHubApiClient {
  async function request<T>(
    path: string,
  ): Promise<{ data: T | null; error: GitHubApiError | null }> {
    const token = await credentials.getInstallationToken();

    const url = `${GITHUB_API_BASE}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'teamem',
        },
      });
    } catch (err) {
      throw new GitHubApiError(
        'server_error',
        0,
        `GitHub API request failed (network): ${String(err).slice(0, 200)}`,
      );
    }

    if (response.status === 404) {
      return { data: null, error: null };
    }

    if (response.status === 401 || response.status === 403) {
      const body = await response.text().catch(() => '');
      throw new GitHubApiError(
        'unauthorized',
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

    const data = (await response.json()) as T;
    return { data, error: null };
  }

  return {
    async getPullRequestsForCommit(
      owner: string,
      repo: string,
      sha: string,
    ): Promise<GitHubPullRequestRef[] | null> {
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/pulls`;
      const { data, error } = await request<RawPullRequest[]>(path);

      if (error) throw error;
      if (data === null) return null; // 404 = commit not found
      if (!Array.isArray(data)) return [];

      return data.map(mapPullRequest);
    },
  };
}

/** Map a raw GitHub API PR object to our typed ref. Exported for tests. */
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
