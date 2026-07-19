/**
 * Anchor resolver — unit tests (DUA-147 / M0-GH-07).
 *
 * Tests the commit→PR resolution logic: merged PRs, open PRs, no-PR commits,
 * null (404) responses, ordering by confidence, and the core design principle:
 * never make speculative associations.
 *
 * All tests use a fake API client — no real GitHub access.
 */
import { describe, expect, it } from 'vitest';
import {
  createAnchorResolver,
  type CommitAnchors,
  type PullRequestAnchor,
} from './anchor-resolver.js';
import type { GitHubApiClient, GitHubPullRequestRef } from './app-api-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fake API client that returns the given PRs for any commit query. */
function fakeApiClient(
  prs: GitHubPullRequestRef[] | null,
  predicate?: (owner: string, repo: string, sha: string) => GitHubPullRequestRef[] | null,
): GitHubApiClient {
  return {
    getPullRequestsForCommit: async (owner, repo, sha) =>
      predicate ? predicate(owner, repo, sha) : prs,
  };
}

/** A merged PR fixture. */
function mergedPr(overrides: Partial<GitHubPullRequestRef> = {}): GitHubPullRequestRef {
  return {
    number: 42,
    title: 'Fix auth bug',
    state: 'closed',
    mergedAt: '2026-07-15T10:30:00Z',
    htmlUrl: 'https://github.com/o/r/pull/42',
    headSha: 'abc123',
    baseRef: 'main',
    ...overrides,
  };
}

/** An open (unmerged) PR fixture. */
function openPr(overrides: Partial<GitHubPullRequestRef> = {}): GitHubPullRequestRef {
  return {
    number: 55,
    title: 'Add new endpoint',
    state: 'open',
    mergedAt: null,
    htmlUrl: 'https://github.com/o/r/pull/55',
    headSha: 'def456',
    baseRef: 'feature/new',
    ...overrides,
  };
}

/** A closed-unmerged PR fixture. */
function closedUnmergedPr(overrides: Partial<GitHubPullRequestRef> = {}): GitHubPullRequestRef {
  return {
    number: 10,
    title: 'Old attempt',
    state: 'closed',
    mergedAt: null,
    htmlUrl: 'https://github.com/o/r/pull/10',
    headSha: 'old123',
    baseRef: 'main',
    ...overrides,
  };
}

// ── resolveCommit ────────────────────────────────────────────────────────────

describe('resolveCommit', () => {
  describe('success paths', () => {
    it('resolves a commit to a merged PR (highest confidence)', async () => {
      const pr = mergedPr();
      const resolver = createAnchorResolver(fakeApiClient([pr]));

      const result = await resolver.resolveCommit('o', 'r', 'abc123');

      expect(result.commitSha).toBe('abc123');
      expect(result.repository).toBe('o/r');
      expect(result.provenance).toBe('github_api');
      expect(result.pullRequests).toHaveLength(1);

      const anchor = result.pullRequests[0]!;
      expect(anchor.prNumber).toBe(42);
      expect(anchor.prTitle).toBe('Fix auth bug');
      expect(anchor.prState).toBe('closed');
      expect(anchor.prMergedAt).toBe('2026-07-15T10:30:00Z');
      expect(anchor.prUrl).toBe('https://github.com/o/r/pull/42');
      expect(anchor.prHeadSha).toBe('abc123');
      expect(anchor.prBaseRef).toBe('main');
      expect(anchor.confidence).toBe('merged');
    });

    it('resolves a commit to an open PR with open_head confidence', async () => {
      const pr = openPr();
      const resolver = createAnchorResolver(fakeApiClient([pr]));

      const result = await resolver.resolveCommit('o', 'r', 'def456');

      expect(result.pullRequests).toHaveLength(1);
      expect(result.pullRequests[0]!.confidence).toBe('open_head');
    });

    it('resolves a closed-unmerged PR with closed_unmerged confidence', async () => {
      const pr = closedUnmergedPr();
      const resolver = createAnchorResolver(fakeApiClient([pr]));

      const result = await resolver.resolveCommit('o', 'r', 'old123');

      expect(result.pullRequests).toHaveLength(1);
      expect(result.pullRequests[0]!.confidence).toBe('closed_unmerged');
    });

    it('returns empty PR list when commit has no associated PRs', async () => {
      const resolver = createAnchorResolver(fakeApiClient([]));

      const result = await resolver.resolveCommit('o', 'r', 'lonely-commit');

      expect(result.pullRequests).toEqual([]);
      expect(result.commitSha).toBe('lonely-commit');
      expect(result.repository).toBe('o/r');
    });

    it('returns empty PR list when the API returns null (commit/repo not found)', async () => {
      const resolver = createAnchorResolver(fakeApiClient(null));

      const result = await resolver.resolveCommit('o', 'r', 'nonexistent');

      expect(result.pullRequests).toEqual([]);
    });

    it('handles multiple PRs for one commit and sorts by confidence', async () => {
      // A commit that appears in a closed-unmerged PR, an open PR, and a
      // merged PR (unusual but possible with rebases/cherry-picks).
      const prs = [
        closedUnmergedPr({ number: 10 }),
        openPr({ number: 55 }),
        mergedPr({ number: 42 }),
      ];
      const resolver = createAnchorResolver(fakeApiClient(prs));

      const result = await resolver.resolveCommit('o', 'r', 'multi');

      expect(result.pullRequests).toHaveLength(3);
      expect(result.pullRequests[0]!.confidence).toBe('merged');
      expect(result.pullRequests[0]!.prNumber).toBe(42);
      expect(result.pullRequests[1]!.confidence).toBe('open_head');
      expect(result.pullRequests[1]!.prNumber).toBe(55);
      expect(result.pullRequests[2]!.confidence).toBe('closed_unmerged');
      expect(result.pullRequests[2]!.prNumber).toBe(10);
    });

    it('sorts same-confidence PRs by number descending (newer first)', async () => {
      const prs = [
        mergedPr({ number: 10 }),
        mergedPr({ number: 99 }),
        mergedPr({ number: 42 }),
      ];
      const resolver = createAnchorResolver(fakeApiClient(prs));

      const result = await resolver.resolveCommit('o', 'r', 'multi-merged');

      expect(result.pullRequests).toHaveLength(3);
      // All merged, so sorted by number descending
      expect(result.pullRequests[0]!.prNumber).toBe(99);
      expect(result.pullRequests[1]!.prNumber).toBe(42);
      expect(result.pullRequests[2]!.prNumber).toBe(10);
    });
  });

  describe('no speculative association (core design principle)', () => {
    it('never fabricates a PR association when the API returns empty', async () => {
      const resolver = createAnchorResolver(fakeApiClient([]));

      const result = await resolver.resolveCommit('o', 'r', 'abc');

      // Must be exactly empty — no heuristic, no guess, no "maybe-related"
      expect(result.pullRequests).toEqual([]);
    });

    it('never fabricates a PR from commit message patterns', async () => {
      // Many commits have messages like "Merge pull request #42" but we
      // do NOT parse commit messages — that's heuristic/speculative.
      // The resolver only trusts the API.
      const resolver = createAnchorResolver(fakeApiClient([]));

      // Even if we passed a commit that a human would say "clearly belongs
      // to PR #42", the resolver returns empty because the API said so.
      const result = await resolver.resolveCommit('o', 'r', 'merge-pr-42-commit');

      expect(result.pullRequests).toEqual([]);
    });

    it('never guesses PR from branch name', async () => {
      // Branch names often include issue/PR numbers but we don't parse them
      const resolver = createAnchorResolver(fakeApiClient([]));

      const result = await resolver.resolveCommit('o', 'r', 'sha-on-feature-42-branch');

      expect(result.pullRequests).toEqual([]);
    });

    it('preserves all original API fields without synthesis', async () => {
      const pr = mergedPr({
        title: 'Original title from API',
        htmlUrl: 'https://github.com/o/r/pull/42',
      });
      const resolver = createAnchorResolver(fakeApiClient([pr]));

      const result = await resolver.resolveCommit('o', 'r', 'abc');
      const anchor = result.pullRequests[0]!;

      // Every field comes from the API — nothing added, nothing guessed
      expect(anchor.prTitle).toBe('Original title from API');
      expect(anchor.prUrl).toBe('https://github.com/o/r/pull/42');
      expect(anchor.confidence).toBe('merged');
    });
  });

  describe('error propagation', () => {
    it('propagates errors from the API client (auth failures, etc.)', async () => {
      const failingClient: GitHubApiClient = {
        getPullRequestsForCommit: async () => {
          throw new Error('GitHub API auth failure');
        },
      };
      const resolver = createAnchorResolver(failingClient);

      await expect(
        resolver.resolveCommit('o', 'r', 'abc'),
      ).rejects.toThrow('GitHub API auth failure');
    });
  });
});

// ── Type-level safety checks ─────────────────────────────────────────────────

describe('anchor result types', () => {
  it('PullRequestAnchor has all fields populated from API data', () => {
    const anchor: PullRequestAnchor = {
      prNumber: 1,
      prTitle: 'title',
      prState: 'open',
      prMergedAt: null,
      prUrl: 'https://github.com/o/r/pull/1',
      prHeadSha: 'abc',
      prBaseRef: 'main',
      confidence: 'open_head',
    };
    // Type-system check: all fields are present
    expect(anchor.prNumber).toBe(1);
  });

  it('CommitAnchors always has provenance github_api', () => {
    const result: CommitAnchors = {
      commitSha: 'abc',
      repository: 'o/r',
      pullRequests: [],
      provenance: 'github_api',
    };
    expect(result.provenance).toBe('github_api');
  });
});
