/**
 * Pull Request webhook normalization (DUA-144 / M0-GH-04).
 *
 * Pure function that maps a raw GitHub `pull_request` webhook payload onto a
 * single {@link NormalizedEvent} (the connector producer contract from
 * `registry.ts`). It composes the DUA-142 helpers in `common.ts` for the
 * cross-event facts (actor, provenance, delivery id, repository URL) and adds
 * the PR-specific projection: supported action gating, stable PR external
 * id/URL, title/body, merge facts, and the provider-supplied timestamp.
 *
 * Red lines honored:
 *   - Original facts preserved verbatim (§5.4): `sourceEvent`/`sourceAction`
 *     are the raw GitHub event/action strings; `pull_request.user` (the PR
 *     author) is stored separately from the webhook `sender` (the actor who
 *     triggered the delivery). Nothing is fabricated — unknown = null/absent.
 *   - `action` is a SOURCE FACT ONLY. It never participates in idempotency
 *     identity (N1): that is `deliveryId` + `itemKey` (+ channel), so a later
 *     `synchronize` and an `opened` sharing the same delivery/item roll up to
 *     the same identity and are deduped on their payload hash, not their
 *     action. This is the CLI acceptance criterion #2 of DUA-144.
 *   - Unsupported actions are EXPLICITLY ignored: the function returns `null`
 *     so the caller skips the event rather than silently dropping or
 *     fabricating a half-populated record (§5.1).
 *   - The returned `payload` is the raw, un-redacted projection. Redaction
 *     (`stripPrivateTags`) happens later in the receive → persist → enqueue
 *     pipeline (§5.3), once, over the canonical content; this module must not
 *     Leak pre-redaction content anywhere else and must not pre-strip (the
 *     frozen order is strip-then-persist, not strip-in-parser).
 */
import type {
  ActorProvenance,
  OccurredAtProvenance,
} from '@teamem/schema';
import type { NormalizedActor, NormalizedEvent } from '../registry.js';
import {
  extractRepositoryFullName,
  githubActorProvenance,
  githubOccurredAtProvenance,
  normalizeGithubActor,
} from './common.js';

// ── Supported PR actions ─────────────────────────────────────────────────────

/**
 * The PR actions M0 compiles. These are the lifecycle-changing actions that
 * touch the PR's title/body/state/merge — the facts F1 extracts signal from.
 *
 *   - `opened`        : PR created (new title/body, state=open).
 *   - `edited`        : title/body edited (F1 must re-extract from the new
 *                       body; the old body is gone and is never fabricated).
 *   - `synchronize`   : head ref advanced (new commits onto the PR).
 *   - `closed`        : PR closed — merged vs. unmerged is the
 *                       `pull_request.merged` FACT, not a second action
 *                       (GitHub emits `action: "closed"` for both).
 *   - `reopened`      : PR reopened (state flips back to open).
 *
 * Everything else (assigned, unassigned, review_requested,
 * review_request_removed, labeled, unlabeled, ready_for_review,
 * converted_to_draft, milestoned, demilestoned, enqueued, dequeued,
 * auto_merge_enabled, auto_merge_disabled, …) is metadata about the PR, not
 * the PR's content/state, and is intentionally out of M0 scope. The action is
 * still returned as a source fact on the events we DO keep; we do not pretend
 * an ignored action is "unknown".
 */
export const SUPPORTED_PR_ACTIONS = new Set([
  'opened',
  'edited',
  'synchronize',
  'closed',
  'reopened',
]);

/** A freezed view of the set for introspection/tests. */
export function isSupportedPrAction(action: string | undefined): action is string {
  return typeof action === 'string' && SUPPORTED_PR_ACTIONS.has(action);
}

// ── Raw payload shapes (subset we read) ──────────────────────────────────────

/** `pull_request` object, redacted-snapshot subset of GitHub's shape. */
export interface GithubPullRequest {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string | null;
  readonly state?: string; // "open" | "closed"
  readonly merged?: boolean;
  readonly merged_at?: string | null;
  readonly draft?: boolean;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly user?: {
    readonly login?: string;
    readonly id?: number;
    readonly type?: string;
  } | null;
  readonly base?: {
    readonly ref?: string;
    readonly sha?: string;
  } | null;
  readonly head?: {
    readonly ref?: string;
    readonly sha?: string;
  } | null;
}

/** Top-level GitHub `pull_request` webhook payload (subset we read). */
export interface GithubPullRequestWebhook {
  readonly action?: string;
  readonly pull_request?: GithubPullRequest;
  readonly sender?: unknown;
  readonly repository?: unknown;
}

// ── Normalization context ───────────────────────────────────────────────────

/**
 * Facts the webhook handler supplies from outside the payload body. These are
 * NOT taken from the JSON body because they are carrier facts (headers / the
 * signature verification result) — letting the body self-report them would
 * let a forged payload promote itself (§5.4, §8).
 */
export interface PullRequestNormalizationContext {
  /** `X-GitHub-Delivery` — idempotency identity component (N1). */
  readonly deliveryId: string;
  /** Result of verifying `X-Hub-Signature-256` against the raw body. */
  readonly webhookVerified: boolean;
  /**
   * Server receive time as a millisecond-precision UTC ISO 8601 string, used
   * as the `occurredAt` fallback only when the payload carries no usable
   * provider timestamp (§5.4 / N8: time trust is a separate, stated fact).
   */
  readonly serverReceiveTime: string;
}

// ── Timestamp normalization ──────────────────────────────────────────────────

/**
 * Normalize a GitHub timestamp to the frozen contract representation: UTC `Z`,
 * fixed millisecond precision (N8). Returns `null` when `raw` is absent or not
 * a parseable date — the caller never fabricates a time (§5.4).
 *
 * GitHub sends PR timestamps at second precision (`2024-01-15T10:30:00Z`); the
 * contract requires `.000Z`. We rely on `Date#toISOString`, which already
 * emits millisecond precision and UTC `Z`.
 */
export function normalizeGithubTimestamp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// ── Repository name split ────────────────────────────────────────────────────

/**
 * Split a `full_name` (`owner/name`) into its two URL segments. Returns `null`
 * when the shape is incomplete — the caller then omits `url` rather than
 * building a malformed one.
 */
function splitFullName(fullName: string): { owner: string; name: string } | null {
  const idx = fullName.indexOf('/');
  if (idx <= 0 || idx === fullName.length - 1) return null;
  const owner = fullName.slice(0, idx);
  const name = fullName.slice(idx + 1);
  if (owner.length === 0 || name.length === 0) return null;
  return { owner, name };
}

/** Canonical PR URL from a verified-resolved `full_name`. */
function buildPullRequestUrl(fullName: string, number: number): string | undefined {
  const parts = splitFullName(fullName);
  if (!parts) return undefined;
  return `https://github.com/${parts.owner}/${parts.name}/pull/${number}`;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Normalize a GitHub `pull_request` webhook into a {@link NormalizedEvent}, or
 * return `null` when the action is unsupported (§5.1: explicitly ignored, not
 * silently dropped, not fabricated).
 *
 * Throws only for structural violations that make the payload unusable as an
 * idempotency identity anchor (missing `pull_request.number`, missing
 * `action` while inside the supported gate). It does NOT throw for a missing
 * actor, title, body, or timestamp — those are preserved as unknown (null).
 */
export function normalizePullRequestEvent(
  webhook: GithubPullRequestWebhook,
  ctx: PullRequestNormalizationContext,
): NormalizedEvent | null {
  // 1. Action gate — unsupported actions are explicitly ignored.
  const action = webhook.action;
  if (!isSupportedPrAction(action)) {
    return null;
  }

  const pr = webhook.pull_request;
  if (!pr) {
    // A `pull_request` event without a `pull_request` object cannot anchor an
    // idempotency identity (no number → no itemKey, no externalId). Reject
    // loudly rather than emit a fabricated 'root' event.
    throw new Error(
      "pull_request webhook carried no 'pull_request' object (cannot resolve item identity)",
    );
  }

  const number = pr.number;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new Error(
      "pull_request webhook carried no usable 'pull_request.number' (stable item identity anchor)",
    );
  }

  // 2. Repository / externalId / url — stable, human-meaningful PR ref (N1).
  // extractRepositoryFullName reads `payload['repository']`, so pass the
  // whole envelope, not the nested field.
  const repoFullName = extractRepositoryFullName(
    webhook as unknown as Record<string, unknown>,
  );
  if (!repoFullName) {
    // Without a repository we cannot build the stable externalId either.
    throw new Error(
      "pull_request webhook carried no usable 'repository' (cannot resolve stable externalId)",
    );
  }

  const externalId = `${repoFullName}#${number}`;
  const url = buildPullRequestUrl(repoFullName, number);
  const itemKey = String(number);

  // 3. Actor = the webhook `sender` (who triggered the action). The PR's own
  //    `user` (author) is a separate fact stored in the payload projection.
  const actor: NormalizedActor | null = normalizeGithubActor(
    webhook.sender as Parameters<typeof normalizeGithubActor>[0],
  );
  const actorProv: ActorProvenance = githubActorProvenance(ctx.webhookVerified);

  // 4. Provider time (N8): prefer `updated_at` (the event-relevant point in
  //    PR time), fall back to `created_at`, then to the server receive time.
  //    The provenance records WHICH source was used — never both.
  const providerTime =
    normalizeGithubTimestamp(pr.updated_at) ??
    normalizeGithubTimestamp(pr.created_at);
  const occurredAt = providerTime ?? ctx.serverReceiveTime;
  const occurredAtProvenance: OccurredAtProvenance = githubOccurredAtProvenance(
    providerTime !== null,
  );

  // 5. Merge fact: GitHub emits `action: "closed"` for BOTH merged and
  //    unmerged closes; the merge fact is `pull_request.merged` (and
  //    `merged_at`). Preserve both verbatim (§5.4).
  const merged = pr.merged === true;
  const mergedAt = normalizeGithubTimestamp(pr.merged_at);

  // 6. Author (PR author) — separate from the trigger actor (sender).
  const author = pr.user
    ? {
        login: pr.user.login,
        id: pr.user.id,
        type: pr.user.type,
      }
    : null;

  // 7. Base/head refs — the branch context F1 needs to ground a PR signal.
  const base =
    pr.base && typeof pr.base.ref === 'string' && typeof pr.base.sha === 'string'
      ? { ref: pr.base.ref, sha: pr.base.sha }
      : null;
  const head =
    pr.head && typeof pr.head.ref === 'string' && typeof pr.head.sha === 'string'
      ? { ref: pr.head.ref, sha: pr.head.sha }
      : null;

  // 8. State: coerce to the closed vocabulary GitHub actually uses. We do NOT
  //    invent new states; an unknown value is preserved verbatim (original
  //    facts) and the consumer handles it. For M0 we only need open/closed for
  //    ordering, so normalize just those two.
  const state: string =
    pr.state === 'open' || pr.state === 'closed' ? pr.state : pr.state ?? 'unknown';

  // 9. Body: `null` is GitHub's "no body" sentinel — preserve as null, do NOT
  //    coerce to empty string (§5.4: preserve unknown as unknown).
  const body = pr.body === null ? null : typeof pr.body === 'string' ? pr.body : null;

  const payload: GithubPullRequestFacts = {
    action,
    number,
    title: typeof pr.title === 'string' ? pr.title : null,
    body,
    state,
    merged,
    mergedAt,
    draft: pr.draft === true,
    base,
    head,
    author,
    createdAt: normalizeGithubTimestamp(pr.created_at),
    updatedAt: normalizeGithubTimestamp(pr.updated_at),
  };

  return {
    connectorKind: 'github',
    eventKind: 'github_pr',
    sourceEvent: 'pull_request',
    sourceAction: action,
    deliveryId: ctx.deliveryId,
    itemKey,
    externalId,
    url,
    actor,
    actorProvenance: actorProv,
    occurredAt,
    occurredAtProvenance,
    payload: payload as unknown as Record<string, unknown>,
  };
}

// ── Stored payload projection (typed view for the compiler / tests) ───────────

/**
 * The PR facts projected into {@link NormalizedEvent.payload}. This is the
 * shape F1 sees; it is a deliberately small, stable subset (title/body/state/
 * merge/refs) rather than the raw GitHub object so provider schema drift does
 * not leak into the compiler contract.
 */
export interface GithubPullRequestFacts {
  readonly action: string;
  readonly number: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly state: string; // "open" | "closed" | (preserved unknown)
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly draft: boolean;
  readonly base: { readonly ref: string; readonly sha: string } | null;
  readonly head: { readonly ref: string; readonly sha: string } | null;
  readonly author: {
    readonly login?: string;
    readonly id?: number;
    readonly type?: string;
  } | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * Narrow a {@link NormalizedEvent.payload} (typed `Record<string, unknown>`)
 * back to the typed PR facts view. Returns `null` when the payload shape is
 * not a PR-facts projection (e.g. the event isn't a PR event). Consumers use
 * this to read structured PR facts without re-parsing GitHub's raw payload.
 */
export function asPullRequestFacts(
  payload: Record<string, unknown>,
): GithubPullRequestFacts | null {
  const candidate = payload as unknown as GithubPullRequestFacts;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof candidate.action !== 'string' ||
    typeof candidate.number !== 'number'
  ) {
    return null;
  }
  return candidate;
}