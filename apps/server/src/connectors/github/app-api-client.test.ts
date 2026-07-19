/**
 * GitHub App API client — unit tests (DUA-147 / M0-GH-07).
 *
 * Tests the minimal API client against HTTP fixtures: success paths,
 * 404 (no data), auth failures, rate limiting, and the commit→PRs
 * endpoint. All fetch calls are mocked — no real GitHub API access.
 *
 * Also verifies that credentials (tokens) never leak into error messages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubApiClient,
  GitHubApiError,
  mapPullRequest,
} from './app-api-client.js';
import type { GitHubAppCredentialsProvider } from './app-credentials.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Credentials provider that always returns a fixed token. */
function fakeCredentials(token = 'ghs_test-token'): GitHubAppCredentialsProvider {
  return {
    getInstallationToken: async () => token,
  };
}

/** A valid PR fixture matching GitHub's API shape. */
const prFixture = {
  number: 42,
  title: 'Fix authentication bug',
  state: 'closed',
  merged_at: '2026-07-15T10:30:00Z',
  html_url: 'https://github.com/octocat/Hello-World/pull/42',
  head: { sha: 'abc123def456' },
  base: { ref: 'main' },
};

/** Another PR fixture (open, unmerged). */
const openPrFixture = {
  number: 55,
  title: 'Add new endpoint',
  state: 'open',
  merged_at: null,
  html_url: 'https://github.com/octocat/Hello-World/pull/55',
  head: { sha: 'def789abc012' },
  base: { ref: 'feature/new-endpoint' },
};

// ── mapPullRequest ───────────────────────────────────────────────────────────

describe('mapPullRequest', () => {
  it('maps raw GitHub PR shape to typed ref', () => {
    const result = mapPullRequest(prFixture);
    expect(result).toEqual({
      number: 42,
      title: 'Fix authentication bug',
      state: 'closed',
      mergedAt: '2026-07-15T10:30:00Z',
      htmlUrl: 'https://github.com/octocat/Hello-World/pull/42',
      headSha: 'abc123def456',
      baseRef: 'main',
    });
  });

  it('preserves null merged_at as null (never coerces to empty string)', () => {
    const result = mapPullRequest(openPrFixture);
    expect(result.mergedAt).toBeNull();
  });
});

// ── getPullRequestsForCommit ─────────────────────────────────────────────────

describe('getPullRequestsForCommit', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: ReturnType<typeof createGitHubApiClient>;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = createGitHubApiClient(fakeCredentials(), mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('success paths', () => {
    it('returns PRs when the commit is associated with PRs', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [prFixture, openPrFixture],
      });

      const result = await client.getPullRequestsForCommit('octocat', 'Hello-World', 'abc123');

      expect(result).toHaveLength(2);
      expect(result![0]!.number).toBe(42);
      expect(result![0]!.mergedAt).toBe('2026-07-15T10:30:00Z');
      expect(result![1]!.number).toBe(55);
      expect(result![1]!.mergedAt).toBeNull();
    });

    it('returns empty array when the commit has no associated PRs', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });

      const result = await client.getPullRequestsForCommit('octocat', 'Hello-World', 'no-pr-commit');

      expect(result).toEqual([]);
    });

    it('returns null for 404 (commit or repo not found)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const result = await client.getPullRequestsForCommit('octocat', 'nonexistent', 'abc123');

      expect(result).toBeNull();
    });

    it('calls the correct GitHub API endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await client.getPullRequestsForCommit('octocat', 'Hello-World', 'abc123');

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe('https://api.github.com/repos/octocat/Hello-World/commits/abc123/pulls');
    });

    it('URL-encodes owner, repo, and sha', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await client.getPullRequestsForCommit('o cto', 'H@llo', 'sha/with?chars');

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('o%20cto');
      expect(url).toContain('H%40llo');
      expect(url).toContain('sha%2Fwith%3Fchars');
    });

    it('passes the Bearer token in Authorization header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await client.getPullRequestsForCommit('o', 'r', 's');

      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers?.['Authorization']).toBe('Bearer ghs_test-token');
      expect(headers?.['Accept']).toBe('application/vnd.github+json');
    });
  });

  describe('failure paths', () => {
    it('throws GitHubApiError with code unauthorized on 401', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => '{"message":"Bad credentials"}',
      });

      await expect(
        client.getPullRequestsForCommit('o', 'r', 's'),
      ).rejects.toThrow(GitHubApiError);

      let error: GitHubApiError | null = null;
      try {
        await client.getPullRequestsForCommit('o', 'r', 's');
      } catch (e) {
        error = e as GitHubApiError;
      }
      expect(error!.code).toBe('unauthorized');
      expect(error!.status).toBe(401);
    });

    it('throws GitHubApiError with code unauthorized on 403', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => '{"message":"Forbidden"}',
      });

      await expect(
        client.getPullRequestsForCommit('o', 'r', 's'),
      ).rejects.toThrow(GitHubApiError);

      let error: GitHubApiError | null = null;
      try {
        await client.getPullRequestsForCommit('o', 'r', 's');
      } catch (e) {
        error = e as GitHubApiError;
      }
      expect(error!.code).toBe('unauthorized');
    });

    it('throws GitHubApiError with code rate_limited on 429', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '60' }),
        text: async () => 'rate limited',
      });

      await expect(
        client.getPullRequestsForCommit('o', 'r', 's'),
      ).rejects.toThrow(GitHubApiError);

      let error: GitHubApiError | null = null;
      try {
        await client.getPullRequestsForCommit('o', 'r', 's');
      } catch (e) {
        error = e as GitHubApiError;
      }
      expect(error!.code).toBe('rate_limited');
      expect(error!.message).toContain('retry after 60s');
    });

    it('throws GitHubApiError with code server_error on 500', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(
        client.getPullRequestsForCommit('o', 'r', 's'),
      ).rejects.toThrow(GitHubApiError);

      let error: GitHubApiError | null = null;
      try {
        await client.getPullRequestsForCommit('o', 'r', 's');
      } catch (e) {
        error = e as GitHubApiError;
      }
      expect(error!.code).toBe('server_error');
    });

    it('throws on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        client.getPullRequestsForCommit('o', 'r', 's'),
      ).rejects.toThrow(GitHubApiError);

      let error: GitHubApiError | null = null;
      try {
        await client.getPullRequestsForCommit('o', 'r', 's');
      } catch (e) {
        error = e as GitHubApiError;
      }
      expect(error!.code).toBe('server_error');
    });
  });

  describe('credential leak prevention', () => {
    it('never includes the token in error messages', async () => {
      const token = 'ghs_very-secret-token-12345';
      client = createGitHubApiClient(fakeCredentials(token), mockFetch);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      let error: Error | null = null;
      try {
        await client.getPullRequestsForCommit('o', 'r', 's');
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect(error!.message).not.toContain(token);
    });

    it('truncates error response bodies to 200 chars', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'x'.repeat(500),
      });

      let error: Error | null = null;
      try {
        await client.getPullRequestsForCommit('o', 'r', 's');
      } catch (e) {
        error = e as Error;
      }

      expect(error!.message.length).toBeLessThanOrEqual(300); // message + prefix
      expect(error!.message).not.toContain('x'.repeat(250));
    });
  });
});
