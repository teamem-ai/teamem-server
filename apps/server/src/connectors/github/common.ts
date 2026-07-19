/**
 * GitHub connector normalization helpers (DUA-142).
 *
 * Pure functions that map raw GitHub webhook facts onto the connector
 * producer contract (`registry.ts`'s `NormalizedActor` / `NormalizedEvent`).
 * Each function operates on one discrete fact and returns a value — no I/O,
 * no side effects. The connector's main handler composes them into
 * `NormalizedEvent[]`.
 *
 * Design principle (contract §5.4): always preserve original facts. The raw
 * actor claim, its provenance, and the authenticated credential are stored
 * separately; resolution can be re-run, a resolved string cannot.
 */
import type { ActorProvenance, OccurredAtProvenance } from '@teamem/schema';
import type { NormalizedActor } from '../registry.js';

// ── GitHub webhook header names ───────────────────────────────────────────────
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery' as const;
export const GITHUB_EVENT_HEADER = 'x-github-event' as const;
export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256' as const;

// ── Raw GitHub webhook payload shapes (subset we need) ────────────────────────

/**
 * GitHub sender object from a webhook payload. All fields are optional
 * because GitHub may omit any of them (e.g. a bot may lack `login`).
 * We never fabricate a sender when it is absent — null means unknown (N2).
 */
export interface GithubSender {
  readonly login?: string;
  readonly id?: number;
  readonly type?: string; // "User" | "Bot" | "Organization" | ...
}

/**
 * Repository object from a GitHub webhook payload. We extract
 * `full_name` (owner/name) for canonical URL construction.
 */
export interface GithubRepository {
  readonly full_name?: string;
  readonly owner?: { readonly login?: string };
  readonly name?: string;
}

/**
 * Installation object from a GitHub App webhook payload.
 */
export interface GithubInstallation {
  readonly id?: number;
}

// ── Actor normalization ───────────────────────────────────────────────────────

/**
 * Map a raw GitHub sender onto a `NormalizedActor` or `null`.
 *
 * - `type: "User"` → `kind: 'human'`
 * - `type: "Bot" | "Organization"` or any other type → `kind: 'service'`
 * - Missing `id` → `null` (never fabricated; N2 general rule)
 *
 * `providerUserId` is the stable numeric ID (string). `displayLogin` is a
 * mutable snapshot — a login change must not alter the provider user ID
 * (CLI acceptance criterion: "可变的 login 变化不会改变 provider 用户 ID").
 */
export function normalizeGithubActor(sender: GithubSender | undefined | null): NormalizedActor | null {
  if (!sender || sender.id === undefined || sender.id === null) {
    return null;
  }

  const kind: NormalizedActor['kind'] = sender.type === 'User' ? 'human' : 'service';

  return {
    kind,
    provider: 'github',
    providerUserId: String(sender.id),
    displayLogin: sender.login,
  };
}

// ── Provenance mapping ────────────────────────────────────────────────────────

/**
 * Map the webhook verification result to the actor provenance fact.
 * A signature-verified GitHub webhook is the only channel that can produce
 * `webhook_verified` (contract N2). Client-submitted actors can never
 * obtain this provenance.
 */
export function githubActorProvenance(webhookVerified: boolean): ActorProvenance {
  return webhookVerified ? 'webhook_verified' : 'unknown';
}

/**
 * Map the timestamp source to the occurred-at provenance fact.
 * GitHub webhooks carry a `timestamp` or event-level timestamps — these
 * are provider-supplied when extracted from the verified payload (N8).
 */
export function githubOccurredAtProvenance(
  hasProviderTimestamp: boolean,
): OccurredAtProvenance {
  return hasProviderTimestamp ? 'provider' : 'server';
}

// ── Delivery ID ───────────────────────────────────────────────────────────────

/**
 * Extract the delivery ID from GitHub webhook headers.
 * The `X-GitHub-Delivery` header is a UUID that identifies this specific
 * webhook delivery — used as the idempotency identity component (N1).
 *
 * Returns `undefined` when the header is missing (the caller must reject
 * such events rather than fabricate a delivery ID).
 */
export function extractDeliveryId(
  headers: Record<string, string | undefined>,
): string | undefined {
  const raw = headers[GITHUB_DELIVERY_HEADER];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return undefined;
  }
  return raw.trim();
}

// ── Installation facts ────────────────────────────────────────────────────────

/**
 * Extract the GitHub App installation ID from a webhook payload.
 * Present in App-related webhook events; absent for regular OAuth events.
 */
export function extractInstallationId(
  payload: Record<string, unknown>,
): string | undefined {
  const installation = payload['installation'] as GithubInstallation | undefined;
  if (!installation || installation.id === undefined || installation.id === null) {
    return undefined;
  }
  return String(installation.id);
}

// ── Repository facts ──────────────────────────────────────────────────────────

/**
 * Extract the repository full name (owner/name) from a GitHub webhook payload.
 * Returns `undefined` when the repository shape is absent or incomplete.
 */
export function extractRepositoryFullName(
  payload: Record<string, unknown>,
): string | undefined {
  const repo = payload['repository'] as GithubRepository | undefined;
  if (!repo) return undefined;
  if (typeof repo.full_name === 'string' && repo.full_name.length > 0) {
    return repo.full_name;
  }
  const ownerLogin = repo.owner?.login;
  const repoName = repo.name;
  if (typeof ownerLogin === 'string' && typeof repoName === 'string' && ownerLogin.length > 0 && repoName.length > 0) {
    return `${ownerLogin}/${repoName}`;
  }
  return undefined;
}

// ── Canonical URL construction ────────────────────────────────────────────────

const GITHUB_BASE_URL = 'https://github.com';

/** Canonical URL for a commit: `https://github.com/{owner}/{repo}/commit/{sha}` */
export function githubCommitUrl(owner: string, repo: string, sha: string): string {
  return `${GITHUB_BASE_URL}/${owner}/${repo}/commit/${sha}`;
}

/** Canonical URL for a pull request: `https://github.com/{owner}/{repo}/pull/{number}` */
export function githubPullRequestUrl(owner: string, repo: string, number: number): string {
  return `${GITHUB_BASE_URL}/${owner}/${repo}/pull/${number}`;
}

/** Canonical URL for an issue: `https://github.com/{owner}/{repo}/issues/{number}` */
export function githubIssueUrl(owner: string, repo: string, number: number): string {
  return `${GITHUB_BASE_URL}/${owner}/${repo}/issues/${number}`;
}

/** Canonical URL for a repository: `https://github.com/{owner}/{repo}` */
export function githubRepositoryUrl(owner: string, repo: string): string {
  return `${GITHUB_BASE_URL}/${owner}/${repo}`;
}

// ── Event kind mapping ────────────────────────────────────────────────────────

/**
 * Map a GitHub webhook event type string to the stored `sourceKind` value.
 * Returns `undefined` for event types we do not yet handle — the caller
 * must skip such events rather than silently drop them.
 */
export function mapGithubEventKind(
  githubEvent: string,
): string | undefined {
  switch (githubEvent) {
    case 'push':
      return 'github_commit';
    case 'pull_request':
      return 'github_pr';
    case 'issues':
      return 'github_issue';
    case 'issue_comment':
    case 'pull_request_review_comment':
    case 'pull_request_review':
      return 'github_pr_comment';
    default:
      return undefined;
  }
}

/**
 * Extract the item key (sub-item ID within a delivery) for a GitHub event.
 * For commits it is the SHA; for PRs/issues it is the number; for comments
 * the comment ID. Falls back to `'root'` when no specific sub-item can be
 * determined.
 */
export function extractGithubItemKey(
  githubEvent: string,
  payload: Record<string, unknown>,
): string {
  switch (githubEvent) {
    case 'push': {
      const after = payload['after'];
      return typeof after === 'string' && after.length > 0 ? after : 'root';
    }
    case 'pull_request': {
      const pr = payload['pull_request'] as { number?: number } | undefined;
      return pr?.number !== undefined ? String(pr.number) : 'root';
    }
    case 'issues': {
      const issue = payload['issue'] as { number?: number } | undefined;
      return issue?.number !== undefined ? String(issue.number) : 'root';
    }
    case 'issue_comment':
    case 'pull_request_review_comment':
    case 'pull_request_review': {
      const comment = payload['comment'] as { id?: number } | undefined;
      return comment?.id !== undefined ? String(comment.id) : 'root';
    }
    default:
      return 'root';
  }
}
