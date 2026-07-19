/**
 * GitHub `issues` webhook normalizer (M0-GH-05, DUA-145).
 *
 * Maps a single verified GitHub "issues" webhook delivery onto the connector
 * producer contract (`registry.ts`'s `NormalizedEvent`) for the
 * `github_issue` source kind. Pure function — no I/O, no side effects. The
 * connector's main handler (M0-GH-0x) will compose this with signature
 * verification and persistence; here we own one discrete fact.
 *
 * What this parser is responsible for (the task's REQUIRED results):
 *
 *  - Supported issue actions: see `SUPPORTED_ISSUE_ACTIONS`. Anything else is
 *    an *explicit* rejection (the caller skips the delivery) — not a silent
 *    fallthrough that silently invents a source-action.
 *  - Stable issue identity: per-repo GitHub issue `number` is the
 *    stable item key; `owner/repo#<number>` is the human-meaningful
 *    `externalId`; `node_id` (the GraphQL global id, stable across repo
 *    renames) is preserved in the payload for F2 anchoring.
 *  - Canonical issue URL (`https://github.com/{owner}/{repo}/issues/{n}`).
 *  - Title, body, and label names are extracted into a structured payload.
 *  - Actor is resolved from `sender` via the shared `normalizeGithubActor`
 *    (N2: never fabricated; null when sender.id is absent).
 *  - Provider timestamp: `issue.updated_at` (the GitHub-supplied
 *    issue-event time) becomes `occurredAt` at fixed ms-precision UTC;
 *    `occurredAtProvenance = 'provider'` (N8).
 *  - Redaction before persistence (AGENTS.md §5.3): a `<private>…</private>`
 *    section inside the parsed payload is stripped recursively BEFORE the
 *    `NormalizedEvent` is constructed — including body, title, and label
 *    names. The connector-storage layer additionally hashes the already-
 *    redacted content; this parser never leaves a pre-strip copy around.
 *  - PR-in-issue-shape rejection: GitHub fires an `issues` webhook whose
 *    `issue` object IS a pull request (the JSON carries a non-null
 *    `pull_request` pointer). Such a delivery must be handled by the PR
 *    parser, never silently coerced into an issue event. We return a typed
 *    reject — the caller MUST drop it from the issue stream; the PR webhook
 *    delivery (a different `X-GitHub-Delivery`) carries the real `pull_request`
 *    event and lands as a distinct `github_pr` event.
 *
 * Boundary invariants (red lines):
 *  - Every cross-boundary input is Zod-validated: the webhook payload is
 *    parsed before any field is touched. We are explicitly loose on GitHub's
 *    extra fields (`.passthrough()`) because GitHub legitimately extends the
 *    webhook payload; strictness is enforced on the fields we consume.
 *  - The parser does NOT construct `webhook_verified` provenance unless its
 *    caller asserts `webhookVerified: true`. The connector layer is the only
 *    place that assertion is honest (N2).
 *  - No fixtures, no mock responses, no silent fallback in production paths.
 */
import { z } from 'zod';
import type { NormalizedEvent } from '../registry.js';
import {
  githubActorProvenance,
  githubIssueUrl,
  githubOccurredAtProvenance,
  githubRepositoryUrl,
  normalizeGithubActor,
} from './common.js';
import { stripPrivateTags } from '../../security/private-tags.js';

/** The raw GitHub webhook event name this parser owns. */
export const GITHUB_ISSUES_EVENT = 'issues' as const;

/** The closed-vocabulary event kind this parser emits onto the registry. */
export const GITHUB_ISSUE_EVENT_KIND = 'github_issue' as const;

/**
 * M0-supported `issues` webhook actions.
 *
 * The frozen contract leaves `source.action` an OPEN string (raw provider
 * action, Q6), but THIS parser is explicit about which actions it produces
 * an event for. A narrower M0 set keeps the compilation surface intentional
 * — future GitHub actions don't silently flow into knowledge without a code
 * change here. The omitted actions (`milestoned`, `locked`, `pinned`, …)
 * are noise from a knowledge-compilation perspective; the caller skips them
 * as a typed `unsupported_action` reject.
 */
export const SUPPORTED_ISSUE_ACTIONS = [
  'opened',
  'closed',
  'reopened',
  'edited',
  'deleted',
  'transferred',
  'labeled',
  'unlabeled',
  'assigned',
  'unassigned',
] as const;
export type SupportedIssueAction = (typeof SUPPORTED_ISSUE_ACTIONS)[number];

const SUPPORTED_ACTION_SET: ReadonlySet<string> = new Set(SUPPORTED_ISSUE_ACTIONS);

// ── Raw GitHub webhook payload shape (subset we consume) ─────────────────────
//
// `.passthrough()` is deliberate: GitHub extends webhook payloads over time
// (assignees, milestones, reactions, …) and we only need to validate the
// fields we actually consume. Validation of the consumed fields is strict
// (each is a typed schema element).

const githubLabelSchema = z
  .strictObject({
    id: z.number().int().nonnegative().optional(),
    name: z.string(),
  })
  .passthrough();

/**
 * The `issue.pull_request` pointer. Present iff the "issue" is actually a
 * pull request (GitHub fires `issues` webhooks for PRs as well, because a
 * PR is an issue subtype). We deliberately do not constrain its inner
 * shape — its very presence is the routing signal this parser must act on.
 */
const issuePullRequestPointerSchema = z
  .object({
    url: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough()
  .nullable();

const githubIssueInnerSchema = z
  .strictObject({
    // GitHub's REST issue `id` is a stable per-repo integer; PR and issue
    // share one number space, so the integer `id` distinguishes a (renamed)
    // issue from a same-number PR that may have existed before — never used
    // as our itemKey (the REST `number` is what humans cite), but preserved
    // for F2 anchoring.
    id: z.number().int().nonnegative(),
    number: z.number().int().nonnegative(),
    node_id: z.string().min(1).optional(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    labels: z.array(githubLabelSchema),
    html_url: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullable().optional(),
    pull_request: issuePullRequestPointerSchema.optional(),
  })
  .passthrough();

const githubRepositorySchema = z
  .strictObject({
    full_name: z.string().optional(),
    name: z.string().optional(),
    owner: z
      .strictObject({ login: z.string().optional() })
      .passthrough()
      .optional(),
    html_url: z.string().optional(),
  })
  .passthrough();

const githubSenderSchema = z
  .strictObject({
    login: z.string().optional(),
    id: z.number().int().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const rawGithubIssueWebhookSchema = z
  .strictObject({
    action: z.string().min(1),
    issue: githubIssueInnerSchema,
    repository: githubRepositorySchema,
    sender: githubSenderSchema.nullable().optional(),
    installation: z
      .strictObject({ id: z.number().int().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RawGithubIssueWebhook = z.infer<typeof rawGithubIssueWebhookSchema>;

// ── Result type ──────────────────────────────────────────────────────────────

/**
 * Why an `issues` delivery was NOT turned into a `github_issue` event.
 * Rejections are first-class, not exceptions: the connector handler drops
 * them from the issue stream and (where applicable) the PR stream picks the
 * delivery back up. Distinct reasons make the routing decision auditable.
 */
export type IssueRejectReason =
  | 'invalid_payload' // failed Zod — not an `issues` webhook worth keeping
  | 'pr_in_issue_shape' // a PR delivered in `issues` shape — belongs to the PR parser
  | 'unsupported_action'; // an `issues` action we intentionally don't compile

export interface IssueReject {
  readonly ok: false;
  readonly reason: IssueRejectReason;
  readonly message: string;
}

export interface IssueOk {
  readonly ok: true;
  readonly event: NormalizedEvent;
}

export type IssueResult = IssueOk | IssueReject;

// ── Helpers ───────────────────────────────────────────────────────────────────

function reject(reason: IssueRejectReason, message: string): IssueReject {
  return { ok: false, reason, message };
}

/**
 * Normalise a GitHub-issued timestamp string to fixed millisecond-precision
 * UTC ISO 8601 (the frozen `isoDateTime` schema form). Returns null when the
 * provider timestamp cannot be parsed — the caller treats that as a server-
 * time fallback, never as a fabricated provider time.
 */
function toMsIso(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString(); // e.g. 2026-07-17T12:00:00.000Z — always .SSSZ
}

/**
 * Split a repository `full_name` ("owner/name") into parts. Falls back to
 * `repository.owner.login` + `repository.name` when `full_name` is omitted
 * (GitHub has historically shipped both forms).
 */
function splitFull(
  fullName: string | undefined,
  ownerLogin: string | undefined,
  repoName: string | undefined,
): { owner: string; name: string } | null {
  if (typeof fullName === 'string' && fullName.length > 0) {
    const sep = fullName.indexOf('/');
    if (sep > 0 && sep < fullName.length - 1) {
      return {
        owner: fullName.slice(0, sep),
        name: fullName.slice(sep + 1),
      };
    }
  }
  if (typeof ownerLogin === 'string' && typeof repoName === 'string' &&
      ownerLogin.length > 0 && repoName.length > 0) {
    return { owner: ownerLogin, name: repoName };
  }
  return null;
}

function isValidUrl(value: string | undefined): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ── Parser ───────────────────────────────────────────────────────────────────

export interface NormalizeGithubIssueInput {
  /** Raw JSON.parse-d GitHub `issues` webhook payload (untrusted). */
  readonly payload: unknown;
  /** The `X-GitHub-Delivery` header value for this exact delivery. */
  readonly deliveryId: string;
  /** Whether signature verification succeeded for this delivery (N2). */
  readonly webhookVerified: boolean;
}

/**
 * Normalise one GitHub `issues` webhook delivery into a `NormalizedEvent`
 * or a typed rejection.
 *
 * Invariants the caller must uphold (asserted before parsing starts):
 *   - `deliveryId` is a non-empty string from the verified request headers.
 *     An empty delivery id is a caller contract violation — the connector
 *     handler must reject the whole webhook before reaching the parser; we
 *     throw so the bug is observable instead of fabricating a delivery id.
 *
 * Throws `Error` on caller-contract violations only; every payload-level
 * failure is a non-throwing `IssueReject`.
 */
export function normalizeGithubIssueEvent(
  input: NormalizeGithubIssueInput,
): IssueResult {
  const { payload, webhookVerified } = input;
  const deliveryId = input.deliveryId;
  if (typeof deliveryId !== 'string' || deliveryId.trim().length === 0) {
    throw new Error(
      'normalizeGithubIssueEvent: deliveryId must be a non-empty string ' +
        '(the caller must reject a missing X-GitHub-Delivery header before parsing)',
    );
  }

  const parsed = rawGithubIssueWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(
      'invalid_payload',
      `issues webhook payload failed Zod validation: ${z.prettifyError(parsed.error)}`,
    );
  }
  const raw = parsed.data;

  // PR-in-issue-shape: the issue object carries a non-null `pull_request`
  // pointer. GitHub fires `issues` webhooks for PRs (a PR is an issue
  // subtype); the PR parser — keyed off the separate `pull_request` webhook
  // delivery with its OWN X-GitHub-Delivery — owns those. Accepting them
  // here would double-count the same physical GitHub object as both a
  // `github_issue` and a `github_pr`, AND would collide a PR's `number`
  // with an issue's `number` (they share the per-repo number space). Reject.
  if (raw.issue.pull_request !== undefined && raw.issue.pull_request !== null) {
    return reject(
      'pr_in_issue_shape',
      "issues webhook delivery 'issue.pull_request' is present — this is a " +
        'pull request delivered in issue shape; the PR parser owns it',
    );
  }

  if (!SUPPORTED_ACTION_SET.has(raw.action)) {
    return reject(
      'unsupported_action',
      `issues webhook action '${raw.action}' is not in the M0 supported ` +
        `set: ${SUPPORTED_ISSUE_ACTIONS.join(', ')}`,
    );
  }

  const repo = splitFull(
    raw.repository.full_name,
    raw.repository.owner?.login,
    raw.repository.name,
  );
  if (!repo) {
    return reject(
      'invalid_payload',
      "issues webhook payload missing repository 'owner/name' (neither " +
        "'repository.full_name' nor 'owner.login'/'name' is usable)",
    );
  }
  const repoFullName = `${repo.owner}/${repo.name}`;

  const number = raw.issue.number;
  const itemKey = String(number);

  // Canonical issue URL. Prefer GitHub's html_url when it parses; otherwise
  // construct the canonical form from the repo facts. We never trust a
  // malformed html_url silently — fabricating a different URL would lie
  // about the source. The fallback is exact GitHub's documented form.
  const url = isValidUrl(raw.issue.html_url)
    ? raw.issue.html_url
    : githubIssueUrl(repo.owner, repo.name, number);

  const actor = normalizeGithubActor(raw.sender);

  const occurredAt = toMsIso(raw.issue.updated_at) ?? toMsIso(raw.issue.created_at);
  if (!occurredAt) {
    return reject(
      'invalid_payload',
      "issues webhook payload 'issue.updated_at' and 'issue.created_at' are " +
        'both unparseable timestamps; cannot establish a provider occurred_at',
    );
  }

  // Build the structured payload (pre-redaction), then strip `<private>…</private>`
  // from every string in the tree before handing the event to the storage
  // layer. Redaction before persistence (AGENTS.md §5.3).
  const preRedactionPayload: Record<string, unknown> = {
    action: raw.action,
    issue: {
      id: raw.issue.id,
      nodeId: raw.issue.node_id ?? null,
      number,
      // GitHub deliverable fields — stripped below
      title: raw.issue.title,
      body: raw.issue.body ?? '',
      state: raw.issue.state,
      // Labels: preserve order; keep id+name plus GitHub's extras.
      labels: raw.issue.labels.map((l) => ({ id: l.id ?? null, name: l.name })),
      htmlUrl: raw.issue.html_url,
      createdAt: raw.issue.created_at,
      updatedAt: raw.issue.updated_at,
      closedAt: raw.issue.closed_at ?? null,
    },
    repository: {
      fullName: repoFullName,
      url: isValidUrl(raw.repository.html_url)
        ? raw.repository.html_url
        : githubRepositoryUrl(repo.owner, repo.name),
    },
  };
  if (raw.installation?.id !== undefined) {
    preRedactionPayload['installation'] = { id: String(raw.installation.id) };
  }

  const redactedPayload = stripPrivateTags(preRedactionPayload);

  const event: NormalizedEvent = {
    connectorKind: 'github',
    eventKind: GITHUB_ISSUE_EVENT_KIND,
    sourceEvent: GITHUB_ISSUES_EVENT,
    sourceAction: raw.action,
    deliveryId,
    itemKey,
    externalId: `${repoFullName}#${number}`,
    url,
    actor,
    actorProvenance: githubActorProvenance(webhookVerified),
    occurredAt,
    occurredAtProvenance: githubOccurredAtProvenance(true),
    payload: redactedPayload,
  };

  return { ok: true, event };
}