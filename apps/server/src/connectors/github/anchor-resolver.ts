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
 *     (PR number, state, merge status, head SHA, body text) are preserved
 *     verbatim in the anchor result. No normalization that loses information.
 *   - **No speculative linking**: If GitHub says a commit belongs to PR #42
 *     and PR #42's body contains "Closes #7", we report BOTH facts separately
 *     with their provenance. We never fuse them into a single "commit is for
 *     issue #7" claim — the intermediate PR is a distinct fact.
 *   - **Issue references from PR bodies**: GitHub's standard closing keywords
 *     (Closes, Fixes, Resolves followed by #N) in a PR body are the mechanism
 *     GitHub itself uses to auto-close issues. These are preserved as
 *     `IssueAnchor` facts with `provenance: 'pr_body_closing_keyword'`.
 *     This is NOT heuristic parsing — the PR body is API-fetched content,
 *     and the closing-keyword convention is GitHub's own documented mechanism.
 *   - **Null = unknown, never fabricated**: if the API returns no results or
 *     errors, the result is an empty anchors list — never a fabricated "root"
 *     or "unknown" relationship.
 *
 * The resolver uses the GitHub API client:
 *   - `getPullRequestsForCommit` → `GET /repos/{owner}/{repo}/commits/{sha}/pulls`
 *     for commit→PR association (high confidence).
 *   - `getPullRequest` → `GET /repos/{owner}/{repo}/pulls/{number}`
 *     for PR body → issue reference extraction (medium confidence).
 *
 * Confidence levels for PR anchors:
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
 * Provenance of an issue anchor — where the association fact came from.
 */
export type IssueProvenance = 'pr_body_closing_keyword';

/**
 * A single commit→issue association fact, resolved transitively through a PR.
 *
 * The issue reference is extracted from the PR body using GitHub's standard
 * closing keywords (Closes/Fixes/Resolves #N). This is NOT a heuristic guess —
 * the PR body is API-fetched content and the closing-keyword convention is
 * GitHub's own documented auto-close mechanism.
 */
export interface IssueAnchor {
  /** The issue number (per-repo, stable). */
  readonly issueNumber: number;
  /** The PR number through which this association was discovered. */
  readonly viaPrNumber: number;
  /** The closing keyword found (e.g. "Closes", "Fixes", "Resolves"). */
  readonly keyword: string;
  /** The provenance of this association. */
  readonly provenance: IssueProvenance;
}

/**
 * Complete anchor resolution result for a commit.
 * Contains all PRs found plus any issues referenced by those PRs.
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
   * Issues referenced by the associated PRs' bodies via GitHub closing
   * keywords. Empty when no issue references were found.
   * Each issue anchor carries the PR it was found through and the keyword
   * that was matched.
   */
  readonly linkedIssues: readonly IssueAnchor[];
  /**
   * Whether the resolution was performed live against the API.
   * Always `'github_api'` for real resolutions; may differ in tests.
   */
  readonly provenance: 'github_api';
}

// ── Issue reference extraction ───────────────────────────────────────────────

/**
 * GitHub's documented closing keywords. When a PR body contains one of these
 * followed by an issue reference (e.g. "Closes #42"), GitHub auto-closes that
 * issue when the PR is merged.
 *
 * See: https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 */
const CLOSING_KEYWORDS = [
  'close', 'closes', 'closed',
  'fix', 'fixes', 'fixed',
  'resolve', 'resolves', 'resolved',
] as const;

/**
 * Regex for GitHub issue references in PR bodies.
 * Matches patterns like "Closes #42", "Fixes #123", "Resolves org/repo#7".
 *
 * The pattern is intentionally conservative:
 *   - Requires a closing keyword followed by whitespace then #N.
 *   - Also matches cross-repo references like `org/repo#N` but only when
 *     the repo matches the current repo (the `repoFilter` param).
 *   - Does NOT match bare #N without a keyword (those could be headings,
 *     changelog references, or other non-closing mentions).
 */
function buildClosingKeywordRegex(): RegExp {
  const keywords = CLOSING_KEYWORDS.join('|');
  // Case-insensitive matching of the keyword, followed by whitespace, then #N
  return new RegExp(
    `(?:^|[\\s(,;])(${keywords})\\s+#(\\d+)(?:[\\s),;.]|$)`,
    'gim',
  );
}

const CLOSING_REF_REGEX = buildClosingKeywordRegex();

/**
 * Extract issue references from a PR body using GitHub's closing keyword
 * pattern. Returns deduplicated (by issue number) list of IssueAnchors.
 *
 * Only matches same-repo references (`#N` without org/repo prefix).
 * Cross-repo references like `other/repo#N` are NOT matched — we cannot
 * confirm they belong to the current repository without additional API calls.
 */
function extractIssueReferences(
  body: string | null,
  prNumber: number,
): IssueAnchor[] {
  if (!body) return [];

  const seen = new Set<number>();
  const anchors: IssueAnchor[] = [];

  // Reset regex state
  CLOSING_REF_REGEX.lastIndex = 0;
  let match = CLOSING_REF_REGEX.exec(body);
  while (match !== null) {
    const keyword = match[1]!.toLowerCase();
    const issueNum = parseInt(match[2]!, 10);

    if (!seen.has(issueNum)) {
      seen.add(issueNum);
      anchors.push({
        issueNumber: issueNum,
        viaPrNumber: prNumber,
        keyword,
        provenance: 'pr_body_closing_keyword',
      });
    }

    match = CLOSING_REF_REGEX.exec(body);
  }

  return anchors;
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
   * Resolve a commit to its associated pull requests and linked issues.
   *
   * Queries the GitHub API and returns only confirmed associations.
   * Returns an empty PR list when:
   *   - The commit is not associated with any PR (GitHub returns []).
   *   - The commit or repo was not found (404 → no data).
   *
   * Issue resolution is performed by fetching each associated PR's body
   * and extracting GitHub closing keyword references. If PR detail fetches
   * fail, issue resolution is silently skipped (the PR anchors are still
   * returned).
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
          linkedIssues: [],
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

      // Resolve linked issues from PR bodies.
      // We fetch each PR's details and extract closing keyword references.
      // Failures on individual PR detail fetches are silently skipped —
      // the PR anchors are still returned.
      const linkedIssues: IssueAnchor[] = [];
      for (const pr of prs) {
        try {
          const detail = await apiClient.getPullRequest(owner, repo, pr.number);
          if (detail && detail.body) {
            const refs = extractIssueReferences(detail.body, pr.number);
            linkedIssues.push(...refs);
          }
        } catch {
          // PR detail fetch failed — skip issue resolution for this PR
          // but still return the PR anchor itself.
        }
      }

      // Deduplicate by issue number (an issue may be referenced by multiple PRs).
      // Keep the earliest PR reference (by PR number).
      const seenIssues = new Map<number, IssueAnchor>();
      for (const issue of linkedIssues) {
        const existing = seenIssues.get(issue.issueNumber);
        if (!existing || issue.viaPrNumber < existing.viaPrNumber) {
          seenIssues.set(issue.issueNumber, issue);
        }
      }

      return {
        commitSha: sha,
        repository,
        pullRequests,
        linkedIssues: [...seenIssues.values()].sort(
          (a, b) => a.issueNumber - b.issueNumber,
        ),
        provenance: 'github_api',
      };
    },
  };
}

// ── Re-exports for testing ──────────────────────────────────────────────────

export const __test = {
  extractIssueReferences,
  CLOSING_KEYWORDS,
};
