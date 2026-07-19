/**
 * Anchor resolver — commit → PR / issue association (DUA-147 / M0-GH-07).
 *
 * Resolves commit SHAs to the pull requests (and transitively, the issues)
 * they belong to. Only high-confidence associations confirmed by the GitHub
 * API are returned — never speculative, never guessed.
 *
 * Design principles:
 *   - **High confidence only**: every association is backed by a GitHub API
 *     response. We never guess a PR from a branch name, a commit message
 *     pattern, or a heuristic.
 *   - **Preserve original facts**: the raw GitHub API response fields
 *     (PR number, state, merge status, head SHA) are preserved verbatim in
 *     the anchor result. No normalization that loses information.
 *   - **No speculative linking**: If GitHub says a commit belongs to PR #42
 *     and PR #42 references issue #7, we report BOTH facts separately with
 *     their provenance. We never fuse them into a single "commit is for issue
 *     #7" claim — the intermediate PR is a distinct fact.
 *   - **Null = unknown, never fabricated**: if the API returns no results or
 *     errors, the result is an empty anchors list — never a fabricated "root"
 *     or "unknown" relationship.
 *
 * The resolver uses the GitHub API client's `getPullRequestsForCommit`
 * endpoint, which calls `GET /repos/{owner}/{repo}/commits/{sha}/pulls`.
 * This endpoint returns PRs that contain the commit. For merged PRs GitHub
 * returns only the PR that merged the commit; for open PRs it returns all
 * PRs whose head includes the commit.
 *
 * Confidence levels:
 *   - `merged`: the PR is merged and this commit is reachable from the merge
 *     commit (this is the highest confidence — the code definitely shipped
 *     via this PR).
 *   - `open_head`: the commit is at the tip of an open PR (high confidence
 *     that the author *intends* this to be part of this PR, but the PR isn't
 *     merged yet).
 *   - `closed_unmerged`: the PR was closed without merging — the commit was
 *     at some point associated with this PR, but the PR didn't ship.
 */

import type { GitHubApiClient, GitHubPullRequestRef } from './app-api-client.js';

// ── Result types ─────────────────────────────────────────────────────────────

/** Confidence level of a commit→PR association. */
export type AnchorConfidence = 'merged' | 'open_head' | 'closed_unmerged';

/**
 * A single commit→PR association fact.
 * Every field comes directly from the GitHub API; nothing is synthesized.
 */
export interface PullRequestAnchor {
  /** The PR number (per-repo, stable). */
  readonly prNumber: number;
  /** PR title at the time of resolution. */
  readonly prTitle: string;
  /** PR state: "open" or "closed". */
  readonly prState: string;
  /** Whether the PR was merged (null when the API didn't report it). */
  readonly prMergedAt: string | null;
  /** The PR's canonical HTML URL. */
  readonly prUrl: string;
  /** The head commit SHA of the PR at resolution time. */
  readonly prHeadSha: string;
  /** The base branch ref. */
  readonly prBaseRef: string;
  /** Confidence of this association. */
  readonly confidence: AnchorConfidence;
}

/**
 * Complete anchor resolution result for a commit.
 * Contains all PRs found + the provenance fact of which API was queried.
 */
export interface CommitAnchors {
  /** The commit SHA that was resolved. */
  readonly commitSha: string;
  /** The repository (owner/name). */
  readonly repository: string;
  /**
   * PRs associated with this commit, ordered by confidence (merged first).
   * Empty when no PRs are associated.
   */
  readonly pullRequests: readonly PullRequestAnchor[];
  /**
   * Whether the resolution was performed live against the API.
   * Always `'github_api'` for real resolutions; may differ in tests.
   */
  readonly provenance: 'github_api';
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Compute the confidence level for a PR association.
 */
function computeConfidence(pr: GitHubPullRequestRef): AnchorConfidence {
  if (pr.mergedAt !== null) return 'merged';
  if (pr.state === 'open') return 'open_head';
  return 'closed_unmerged';
}

export interface AnchorResolver {
  /**
   * Resolve a commit to its associated pull requests.
   *
   * Queries the GitHub API and returns only confirmed associations.
   * Returns an empty PR list when:
   *   - The commit is not associated with any PR (GitHub returns []).
   *   - The commit or repo was not found (404 → no data).
   *
   * Never throws for missing data; only throws for auth/network/rate-limit
   * failures that the caller should handle (retry, alert, etc.).
   */
  resolveCommit(owner: string, repo: string, sha: string): Promise<CommitAnchors>;
}

export function createAnchorResolver(
  apiClient: GitHubApiClient,
): AnchorResolver {
  return {
    async resolveCommit(owner: string, repo: string, sha: string): Promise<CommitAnchors> {
      const repository = `${owner}/${repo}`;

      const prs = await apiClient.getPullRequestsForCommit(owner, repo, sha);

      if (prs === null || prs.length === 0) {
        return {
          commitSha: sha,
          repository,
          pullRequests: [],
          provenance: 'github_api',
        };
      }

      const pullRequests: PullRequestAnchor[] = prs.map((pr) => ({
        prNumber: pr.number,
        prTitle: pr.title,
        prState: pr.state,
        prMergedAt: pr.mergedAt,
        prUrl: pr.htmlUrl,
        prHeadSha: pr.headSha,
        prBaseRef: pr.baseRef,
        confidence: computeConfidence(pr),
      }));

      // Sort: merged first, then open_head, then closed_unmerged.
      // Within the same confidence, sort by PR number descending (newer PRs first).
      const confidenceOrder: Record<AnchorConfidence, number> = {
        merged: 0,
        open_head: 1,
        closed_unmerged: 2,
      };
      pullRequests.sort((a, b) => {
        const cmp = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
        if (cmp !== 0) return cmp;
        return b.prNumber - a.prNumber;
      });

      return {
        commitSha: sha,
        repository,
        pullRequests,
        provenance: 'github_api',
      };
    },
  };
}
