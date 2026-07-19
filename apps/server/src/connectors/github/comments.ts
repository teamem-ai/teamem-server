/**
 * GitHub PR-review / issue-comment normalizer (DUA-146).
 *
 * Maps the three GitHub webhook events that carry discussion evidence for the
 * "why" moment onto the connector producer contract (`registry.ts`'s
 * `NormalizedEvent`). These are pure functions: no I/O, no side effects. The
 * future webhook handler (a separate task) composes signature verification
 * (DUA-141), the actor/provenance helpers (DUA-142), and this module.
 *
 * The three events all classify, where applicable, as the FROZEN
 * `github_pr_comment` `source_kind` (packages/schema/src/source.ts), preserved
 * via `eventKind: 'github_pr_comment'`. The raw provider event/action are kept
 * verbatim in `sourceEvent`/`sourceAction` (Q6, N1: idempotent identity is
 * built on channel facts, never on the parsed kind — so a future re-parse must
 * not bypass dedup).
 *
 * Deliverable boundaries (task DUA-146):
 *   - stable comment ID / immutable permalink (CLI acceptance #2 & #3);
 *   - parent PR/issue reference in the stored payload;
 *   - action, actor (preserved raw, never fabricated — N2), and provider time
 *     (N8: time trust is a separate fact from actor trust).
 *
 * Redaction (AGENTS.md §5.3) is NOT applied here. The fixed order is
 * `receive -> Zod validation -> stripPrivateTags -> persist`; the connector
 * lives inside `receive`, so it emits the raw comment body and the ingestion
 * layer strips `<private>` content before persistence. Stripping here would be
 * a duplicate redaction and would also hide original facts from the
 * preserve-original-facts red line (§5.4).
 */
import type { NormalizedEvent } from '../registry.js';
import {
  extractRepositoryFullName,
  githubActorProvenance,
  githubIssueUrl,
  githubOccurredAtProvenance,
  githubPullRequestUrl,
  normalizeGithubActor,
  type GithubSender,
} from './common.js';

// ── Raw GitHub webhook payload shapes (subset we read) ──────────────────────

const GITHUB_BASE_URL = 'https://github.com';

/** Events handled here. All map to the frozen `github_pr_comment` kind. */
export type GithubCommentEventKind =
  | 'issue_comment'
  | 'pull_request_review'
  | 'pull_request_review_comment';

const HANDLED_EVENTS: ReadonlySet<GithubCommentEventKind> = new Set([
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
]);

export function isHandledCommentEvent(
  githubEvent: string,
): githubEvent is GithubCommentEventKind {
  return HANDLED_EVENTS.has(githubEvent as GithubCommentEventKind);
}

/** The kind of parent a comment/review attaches to. */
export type CommentParentType = 'pull_request' | 'issue';

interface GithubCommentObject {
  readonly id?: number;
  readonly body?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly submitted_at?: string;
  readonly html_url?: string;
  readonly state?: string;
  readonly user?: GithubSender;
}

interface GithubParentObject {
  readonly number?: number;
  /** Present on `issue` objects when the issue is actually a PR. */
  readonly pull_request?: unknown;
  readonly html_url?: string;
}

interface CommentEventPayload {
  readonly action?: string;
  readonly comment?: GithubCommentObject;
  readonly review?: GithubCommentObject;
  readonly issue?: GithubParentObject;
  readonly pull_request?: GithubParentObject;
  readonly sender?: GithubSender;
  readonly installation?: { readonly id?: number };
  readonly repository?: unknown;
}

// ── Timestamp normalization ─────────────────────────────────────────────────

/**
 * Parse a GitHub timestamp into the frozen UTC millisecond-precision ISO 8601
 * form required by `@teamem/schema`'s `isoDateTime` (`precision: 3`). GitHub
 * delivers times like `2024-01-15T10:30:00Z` (zero fractional digits); the
 * frozen contract requires exactly three. `Date#toISOString()` always emits
 * three fractional digits in UTC `Z`, so it is the canonical normalizer.
 *
 * Returns `undefined` when the value is absent or unparseable — the caller
 * falls back to server receive-time and records `occurred_at_provenance =
 * 'server'` (N8).
 */
export function normalizeGithubTimestamp(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// ── Canonical permalink construction ────────────────────────────────────────

function splitRepoFullName(fullName: string): { owner: string; repo: string } | undefined {
  const idx = fullName.indexOf('/');
  if (idx <= 0 || idx === fullName.length - 1) return undefined;
  const owner = fullName.slice(0, idx);
  const repo = fullName.slice(idx + 1);
  if (owner.length === 0 || repo.length === 0) return undefined;
  return { owner, repo };
}

/**
 * Anchor appended to the parent URL to point at the specific comment/review.
 * These are GitHub's stable permalink fragment formats — derived solely from
 * the immutable comment/review id, so the permalink is reproducible from the
 * stable id alone (CLI acceptance #3: immutable evidence).
 */
export function githubCommentAnchor(
  githubEvent: GithubCommentEventKind,
  commentId: number,
): string {
  switch (githubEvent) {
    case 'issue_comment':
      return `#issuecomment-${commentId}`;
    case 'pull_request_review_comment':
      return `#discussion_r${commentId}`;
    case 'pull_request_review':
      return `#pullrequestreview-${commentId}`;
  }
}

/**
 * Construct the canonical, immutable permalink for a comment/review from the
 * stable repo + parent + comment id facts. Used as the trusted `url` when the
 * raw payload's `html_url` is absent or not a genuine github.com URL.
 */
export function githubCommentPermalink(
  repoFullName: string,
  parentType: CommentParentType,
  parentNumber: number,
  githubEvent: GithubCommentEventKind,
  commentId: number,
): string | undefined {
  const parts = splitRepoFullName(repoFullName);
  if (!parts) return undefined;
  const parentUrl =
    parentType === 'pull_request'
      ? githubPullRequestUrl(parts.owner, parts.repo, parentNumber)
      : githubIssueUrl(parts.owner, parts.repo, parentNumber);
  return `${parentUrl}${githubCommentAnchor(githubEvent, commentId)}`;
}

/**
 * Decide the trusted permalink. A signature-verified GitHub payload's
 * `html_url` IS GitHub's official immutable permalink, so we prefer it when
 * it is a genuine `https://github.com/...` URL (preserves the original fact,
 * §5.4). A malformed or non-github `html_url` is rejected — never let an
 * attacker-controlled arbitrary URL become the stored "immutable evidence"
 * link — and we fall back to deterministic construction from the stable id.
 */
export function resolveCommentPermalink(
  rawHtmlUrl: string | undefined,
  repoFullName: string,
  parentType: CommentParentType,
  parentNumber: number,
  githubEvent: GithubCommentEventKind,
  commentId: number,
): string | undefined {
  if (typeof rawHtmlUrl === 'string' && rawHtmlUrl.length > 0) {
    try {
      const u = new URL(rawHtmlUrl);
      if (u.protocol === 'https:' && u.host === 'github.com') return rawHtmlUrl;
    } catch {
      // fall through to construction
    }
  }
  return githubCommentPermalink(
    repoFullName,
    parentType,
    parentNumber,
    githubEvent,
    commentId,
  );
}

// ── Parent reference extraction ──────────────────────────────────────────────

interface ParentFacts {
  readonly type: CommentParentType;
  readonly number: number;
  readonly url?: string;
}

function extractParent(
  githubEvent: GithubCommentEventKind,
  payload: CommentEventPayload,
  repoFullName: string,
): ParentFacts | undefined {
  const parts = splitRepoFullName(repoFullName);
  if (!parts) return undefined;

  if (githubEvent === 'issue_comment') {
    const issue = payload.issue;
    if (!issue || issue.number === undefined || issue.number === null) return undefined;
    const type: CommentParentType =
      issue.pull_request !== undefined && issue.pull_request !== null
        ? 'pull_request'
        : 'issue';
    const parentUrl =
      type === 'pull_request'
        ? githubPullRequestUrl(parts.owner, parts.repo, issue.number)
        : githubIssueUrl(parts.owner, parts.repo, issue.number);
    return { type, number: issue.number, url: parentUrl };
  }

  // pull_request_review & pull_request_review_comment
  const pr = payload.pull_request;
  if (!pr || pr.number === undefined || pr.number === null) return undefined;
  return {
    type: 'pull_request',
    number: pr.number,
    url: githubPullRequestUrl(parts.owner, parts.repo, pr.number),
  };
}

// ── Comment/review fact extraction ──────────────────────────────────────────

interface CommentFacts {
  readonly id: number;
  readonly body: string | null;
  readonly rawHtmlUrl?: string;
  readonly reviewState?: string;
  /** Provider timestamp string suitable for `normalizeGithubTimestamp`. */
  readonly providerAt: string | undefined;
}

function extractCommentFacts(
  githubEvent: GithubCommentEventKind,
  payload: CommentEventPayload,
  action: string,
): CommentFacts | undefined {
  const isReview = githubEvent === 'pull_request_review';
  const obj = isReview ? payload.review : payload.comment;
  if (!obj || obj.id === undefined || obj.id === null) return undefined;

  // For created events the relevant "occurred at" is creation; for any later
  // action (edited/deleted/dismissed) the provider's updated/dismissed time
  // is when the change actually happened (N8).
  const providerAt = isReview
    ? obj.submitted_at ?? obj.updated_at ?? obj.created_at
    : action === 'created'
      ? obj.created_at ?? obj.updated_at
      : obj.updated_at ?? obj.created_at;

  return {
    id: obj.id,
    body: obj.body === undefined ? null : obj.body,
    rawHtmlUrl: obj.html_url,
    reviewState: isReview ? obj.state : undefined,
    providerAt,
  };
}

// ── externalId anchor (human-meaningful ref, e.g. octocat/Repo#issuecomment-9) ─

function externalIdAnchor(
  githubEvent: GithubCommentEventKind,
  commentId: number,
): string {
  switch (githubEvent) {
    case 'issue_comment':
      return `issuecomment-${commentId}`;
    case 'pull_request_review_comment':
      return `discussion_r${commentId}`;
    case 'pull_request_review':
      return `pullrequestreview-${commentId}`;
  }
}

// ── Normalizer entry point ──────────────────────────────────────────────────

export interface NormalizeCommentEventInput {
  /** Raw GitHub webhook event name (x-github-event). */
  readonly githubEvent: string;
  /** Parsed webhook payload. */
  readonly payload: Record<string, unknown>;
  /** Already-extracted webhook delivery id (X-GitHub-Delivery). The caller
   * rejects a missing delivery id before calling this — never fabricated. */
  readonly deliveryId: string;
  /** Whether the webhook signature verified (DUA-141). Only a verified
   * webhook may earn `actorProvenance: 'webhook_verified'` (N2). */
  readonly webhookVerified: boolean;
  /** Server receive-time in frozen UTC ms-precision ISO, used as the
   * `occurred_at` fallback when the provider supplies no timestamp (N8). */
  readonly serverTime: string;
}

/**
 * Normalize one GitHub PR-review / issue-comment webhook delivery into a
 * `NormalizedEvent` classified as the frozen `github_pr_comment` kind.
 *
 * Returns `null` when the delivery cannot be turned into trustworthy evidence
 * (unsupported event, missing comment/review id, missing parent, or no
 * repository identity) — `null` means "ignore this delivery"; the caller must
 * not fabricate facts to force a result (§5.4).
 */
export function normalizeCommentEvent(
  input: NormalizeCommentEventInput,
): NormalizedEvent | null {
  const { payload, deliveryId, webhookVerified, serverTime } = input;
  const githubEvent = input.githubEvent;
  if (!isHandledCommentEvent(githubEvent)) return null;
  const typedPayload = payload as CommentEventPayload;

  const repoFullName = extractRepositoryFullName(payload);
  if (!repoFullName) return null; // cannot build stable permalink/externalId

  const action = typedPayload.action;
  if (typeof action !== 'string' || action.length === 0) return null;

  const comment = extractCommentFacts(githubEvent, typedPayload, action);
  if (!comment) return null; // no stable comment/review id → not trustworthy

  const parent = extractParent(githubEvent, typedPayload, repoFullName);
  if (!parent) return null; // a comment without its parent is not evidence

  const permalink = resolveCommentPermalink(
    comment.rawHtmlUrl,
    repoFullName,
    parent.type,
    parent.number,
    githubEvent,
    comment.id,
  );
  // Permalink is the immutable-evidence link (CLI #3). If construction failed
  // (malformed repo name AND no valid html_url) we cannot offer stable
  // evidence — return null rather than store a linkless, id-only fact.
  if (!permalink) return null;

  const actor = normalizeGithubActor(typedPayload.sender);
  const actorProvenance = githubActorProvenance(webhookVerified);

  const providerAt = normalizeGithubTimestamp(comment.providerAt);
  const occurredAt = providerAt ?? serverTime;
  const occurredAtProvenance = githubOccurredAtProvenance(providerAt !== undefined);

  const externalId = `${repoFullName}#${externalIdAnchor(githubEvent, comment.id)}`;

  // Stored payload carries the parent reference, immutable permalink, the raw
  // comment/review id, the action, and the raw provider `html_url` preserved
  // verbatim (§5.4 — original facts kept alongside the normalized url). The
  // `<private>` redaction of `body` is the ingestion layer's job (§5.3).
  const storedPayload: Record<string, unknown> = {
    rawEvent: githubEvent,
    action,
    commentId: comment.id,
    commentUrl: permalink,
    commentHtmlUrl: comment.rawHtmlUrl ?? null,
    parentType: parent.type,
    parentNumber: parent.number,
    parentUrl: parent.url ?? null,
    body: comment.body,
  };
  if (comment.reviewState !== undefined) {
    storedPayload['reviewState'] = comment.reviewState;
  }
  const installationId =
    typeof typedPayload.installation?.id === 'number'
      ? String(typedPayload.installation!.id)
      : undefined;
  if (installationId !== undefined) storedPayload['installationId'] = installationId;

  return {
    connectorKind: 'github',
    eventKind: 'github_pr_comment',
    sourceEvent: githubEvent,
    sourceAction: action,
    deliveryId,
    itemKey: String(comment.id), // stable across edits & redeliveries (CLI #2)
    externalId,
    url: permalink,
    actor,
    actorProvenance,
    occurredAt,
    occurredAtProvenance,
    payload: storedPayload,
  };
}

export { GITHUB_BASE_URL };