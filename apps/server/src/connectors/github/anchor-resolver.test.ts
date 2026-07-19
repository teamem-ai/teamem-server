/**
 * Anchor resolver — unit tests (DUA-147 / M0-GH-07).
 *
 * Tests commit→PR resolution, issue reference extraction from PR bodies,
 * empty/null results, ordering, and the core design principle:
 * never make speculative associations.
 *
 * All PR-list and PR-detail APIs are faked — no real GitHub access.
 */
import { describe, expect, it } from 'vitest';
import {
  createAnchorResolver,
  __test,
  type CommitAnchors,
  type IssueAnchor,
} from './anchor-resolver.js';
import type { GitHubApiClient, GitHubPullRequestRef, GitHubPullRequestDetail } from './app-api-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fake API client with configurable PR list and PR detail responses. */
function fakeApiClient(opts: {
  prs: GitHubPullRequestRef[] | null;
  details?: Map<number, GitHubPullRequestDetail | null>;
}): GitHubApiClient {
  const details = opts.details ?? new Map();
  return {
    getPullRequestsForCommit: async () => opts.prs,
    getPullRequest: async (_owner, _repo, number) => details.get(number) ?? null,
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

/** A PR detail fixture with body. */
function prDetail(
  overrides: Partial<GitHubPullRequestDetail> = {},
): GitHubPullRequestDetail {
  return {
    number: 42,
    title: 'Fix auth bug',
    state: 'closed',
    mergedAt: '2026-07-15T10:30:00Z',
    htmlUrl: 'https://github.com/o/r/pull/42',
    headSha: 'abc123',
    baseRef: 'main',
    body: null,
    ...overrides,
  };
}

// ── extractIssueReferences ───────────────────────────────────────────────────

describe('extractIssueReferences', () => {
  it('extracts single closing keyword references from PR body', () => {
    const body = 'This PR closes #42 and implements the new flow.';
    const refs = __test.extractIssueReferences(body, 99);

    expect(refs).toHaveLength(1);
    expect(refs[0]!.issueNumber).toBe(42);
    expect(refs[0]!.viaPrNumber).toBe(99);
    expect(refs[0]!.keyword).toBe('closes');
    expect(refs[0]!.provenance).toBe('pr_body_closing_keyword');
  });

  it('extracts multiple distinct issue references', () => {
    const body = 'Fixes #10 and closes #20. Also resolves #30.';
    const refs = __test.extractIssueReferences(body, 1);

    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.issueNumber).sort()).toEqual([10, 20, 30]);
  });

  it('deduplicates repeated references to the same issue', () => {
    const body = 'Closes #42. As mentioned above, this fixes #42.';
    const refs = __test.extractIssueReferences(body, 1);

    expect(refs).toHaveLength(1);
    expect(refs[0]!.issueNumber).toBe(42);
  });

  it('matches all documented closing keyword variants', () => {
    const variants = [
      'close #1',
      'closes #2',
      'closed #3',
      'fix #4',
      'fixes #5',
      'fixed #6',
      'resolve #7',
      'resolves #8',
      'resolved #9',
    ];

    for (const variant of variants) {
      const refs = __test.extractIssueReferences(variant, 10);
      expect(refs).toHaveLength(1);
      expect(refs[0]!.keyword).toBe(variant.split(' ')[0]!.toLowerCase());
    }
  });

  it('matches keyword at start of line', () => {
    const refs = __test.extractIssueReferences('Closes #100', 1);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.issueNumber).toBe(100);
  });

  it('matches keyword after punctuation', () => {
    const refs = __test.extractIssueReferences(
      'Some text; fixes #42. More text, resolves #55)',
      1,
    );
    expect(refs).toHaveLength(2);
  });

  it('does NOT match bare issue numbers without closing keywords (#42 alone)', () => {
    const body = 'See also #42 for context. Reference: #99.';
    const refs = __test.extractIssueReferences(body, 1);
    // Bare #N without a closing keyword is NOT extracted — could be
    // a heading, a changelog entry, or a non-closing mention.
    expect(refs).toHaveLength(0);
  });

  it('does NOT match keywords that are part of other words', () => {
    // "unfixed #42" should not match "fixed"
    const body = 'The unfixed #42 bug is still present.';
    const refs = __test.extractIssueReferences(body, 1);
    expect(refs).toHaveLength(0);
  });

  it('returns empty for null body', () => {
    expect(__test.extractIssueReferences(null, 1)).toEqual([]);
  });

  it('returns empty for empty string body', () => {
    expect(__test.extractIssueReferences('', 1)).toEqual([]);
  });

  it('handles body with no issue references gracefully', () => {
    const body = 'This PR updates the documentation and adds examples.';
    expect(__test.extractIssueReferences(body, 1)).toEqual([]);
  });

  it('is case-insensitive for keywords', () => {
    const refs = __test.extractIssueReferences('CLOSES #1 and Fixes #2 and Resolved #3', 1);
    expect(refs).toHaveLength(3);
  });
});

// ── resolveCommit ────────────────────────────────────────────────────────────

describe('resolveCommit', () => {
  describe('success paths', () => {
    it('resolves a commit to a merged PR (highest confidence)', async () => {
      const pr = mergedPr();
      const resolver = createAnchorResolver(fakeApiClient({ prs: [pr] }));

      const result = await resolver.resolveCommit('o', 'r', 'abc123');

      expect(result.commitSha).toBe('abc123');
      expect(result.repository).toBe('o/r');
      expect(result.provenance).toBe('github_api');
      expect(result.pullRequests).toHaveLength(1);

      const anchor = result.pullRequests[0]!;
      expect(anchor.prNumber).toBe(42);
      expect(anchor.confidence).toBe('merged');
    });

    it('resolves linked issues from PR body', async () => {
      const pr = mergedPr({ number: 42 });
      const detail = prDetail({ number: 42, body: 'Closes #7 and fixes #12.' });
      const resolver = createAnchorResolver(
        fakeApiClient({ prs: [pr], details: new Map([[42, detail]]) }),
      );

      const result = await resolver.resolveCommit('o', 'r', 'abc');

      expect(result.pullRequests).toHaveLength(1);
      expect(result.linkedIssues).toHaveLength(2);
      expect(result.linkedIssues[0]!.issueNumber).toBe(7);
      expect(result.linkedIssues[0]!.viaPrNumber).toBe(42);
      expect(result.linkedIssues[0]!.provenance).toBe('pr_body_closing_keyword');
      expect(result.linkedIssues[1]!.issueNumber).toBe(12);
    });

    it('deduplicates issues referenced by multiple PRs', async () => {
      const pr1 = mergedPr({ number: 10 });
      const pr2 = mergedPr({ number: 20 });
      const detail10 = prDetail({ number: 10, body: 'Closes #5.' });
      const detail20 = prDetail({ number: 20, body: 'Fixes #5.' });
      const resolver = createAnchorResolver(
        fakeApiClient({
          prs: [pr1, pr2],
          details: new Map([
            [10, detail10],
            [20, detail20],
          ]),
        }),
      );

      const result = await resolver.resolveCommit('o', 'r', 'abc');

      // Issue #5 referenced by both PRs — deduplicated, keeps earlier PR
      expect(result.linkedIssues).toHaveLength(1);
      expect(result.linkedIssues[0]!.issueNumber).toBe(5);
      expect(result.linkedIssues[0]!.viaPrNumber).toBe(10); // earlier PR
    });

    it('returns empty issues when PRs have no body references', async () => {
      const pr = mergedPr({ number: 42 });
      const detail = prDetail({ number: 42, body: 'Just a simple PR.' });
      const resolver = createAnchorResolver(
        fakeApiClient({ prs: [pr], details: new Map([[42, detail]]) }),
      );

      const result = await resolver.resolveCommit('o', 'r', 'abc');

      expect(result.pullRequests).toHaveLength(1);
      expect(result.linkedIssues).toHaveLength(0);
    });

    it('returns empty issues when PR detail fetch fails (silent skip)', async () => {
      const failingClient: GitHubApiClient = {
        getPullRequestsForCommit: async () => [mergedPr({ number: 42 })],
        getPullRequest: async () => {
          throw new Error('GitHub API error');
        },
      };
      const resolver = createAnchorResolver(failingClient);

      const result = await resolver.resolveCommit('o', 'r', 'abc');

      // PR anchor is still returned; issue resolution silently skipped
      expect(result.pullRequests).toHaveLength(1);
      expect(result.linkedIssues).toHaveLength(0);
    });

    it('returns empty PRs and issues when commit has no associated PRs', async () => {
      const resolver = createAnchorResolver(fakeApiClient({ prs: [] }));

      const result = await resolver.resolveCommit('o', 'r', 'lonely-commit');

      expect(result.pullRequests).toEqual([]);
      expect(result.linkedIssues).toEqual([]);
    });

    it('returns empty when the API returns null (commit/repo not found)', async () => {
      const resolver = createAnchorResolver(fakeApiClient({ prs: null }));

      const result = await resolver.resolveCommit('o', 'r', 'nonexistent');

      expect(result.pullRequests).toEqual([]);
      expect(result.linkedIssues).toEqual([]);
    });
  });

  describe('no speculative association (core design principle)', () => {
    it('never fabricates a PR association when the API returns empty', async () => {
      const resolver = createAnchorResolver(fakeApiClient({ prs: [] }));
      const result = await resolver.resolveCommit('o', 'r', 'abc');
      expect(result.pullRequests).toEqual([]);
      expect(result.linkedIssues).toEqual([]);
    });

    it('never fabricates a PR from commit message patterns', async () => {
      const resolver = createAnchorResolver(fakeApiClient({ prs: [] }));
      const result = await resolver.resolveCommit('o', 'r', 'merge-pr-42-commit');
      expect(result.pullRequests).toEqual([]);
    });

    it('never guesses PR from branch name', async () => {
      const resolver = createAnchorResolver(fakeApiClient({ prs: [] }));
      const result = await resolver.resolveCommit('o', 'r', 'sha-on-feature-42-branch');
      expect(result.pullRequests).toEqual([]);
    });

    it('never extracts bare #N as issue — only closing keywords', async () => {
      const pr = mergedPr({ number: 42 });
      const detail = prDetail({
        number: 42,
        body: 'See #100 for background. Reference: #200.',
      });
      const resolver = createAnchorResolver(
        fakeApiClient({ prs: [pr], details: new Map([[42, detail]]) }),
      );

      const result = await resolver.resolveCommit('o', 'r', 'abc');

      // Bare #N references are NOT extracted — only closing keywords
      expect(result.linkedIssues).toHaveLength(0);
    });
  });

  describe('error propagation', () => {
    it('propagates errors from getPullRequestsForCommit', async () => {
      const failingClient: GitHubApiClient = {
        getPullRequestsForCommit: async () => {
          throw new Error('GitHub API auth failure');
        },
        getPullRequest: async () => null,
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
  it('IssueAnchor has all fields populated', () => {
    const anchor: IssueAnchor = {
      issueNumber: 7,
      viaPrNumber: 42,
      keyword: 'closes',
      provenance: 'pr_body_closing_keyword',
    };
    expect(anchor.issueNumber).toBe(7);
  });

  it('CommitAnchors includes both pullRequests and linkedIssues', () => {
    const result: CommitAnchors = {
      commitSha: 'abc',
      repository: 'o/r',
      pullRequests: [],
      linkedIssues: [],
      provenance: 'github_api',
    };
    expect(result.linkedIssues).toEqual([]);
  });
});
