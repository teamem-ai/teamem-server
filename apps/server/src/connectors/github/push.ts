/**
 * Normalize a GitHub `push` webhook payload (DUA-143, M0-GH-03).
 *
 * Pure function: one webhook *delivery* (identified by `deliveryId`) is
 * expanded into one {@link NormalizedEvent} **per commit**, exactly as the
 * producer contract in `registry.ts` describes for a delivery that splits
 * into sub-items (N1):
 *
 *   - every event shares the SAME `deliveryId` (the `X-GitHub-Delivery`
 *     uuid that identifies this one delivery);
 *   - each event's `itemKey` is the commit SHA (stable, immutable sub-item
 *     id within the delivery);
 *   - each event's `url` is the canonical immutable commit URL
 *     `https://github.com/{owner}/{repo}/commit/{sha}` — an immutable
 *     evidence fact, computed canonically rather than trusted from a raw
 *     payload field so it cannot drift;
 *   - `actor` is the verified sender claim (N2), `actorProvenance` reflects
 *     whether the webhook signature was verified (only signature-verified
 *     deliveries obtain `webhook_verified`);
 *   - `occurredAt` is the commit timestamp (provider fact, N8), normalized
 *     to contract UTC Z + millisecond-precision ISO 8601.
 *
 * Noise handling — the producer contract says `handleWebhook` returns `[]`
 * for deliveries to *ignore*, and the task explicitly requires ignoring
 * unsupported/deleted references:
 *
 *   - `deleted: true` push (a reference is being deleted)  → `[]`;
 *   - `after` is the all-zeros SHA (deletion)              → `[]`;
 *   - `ref` is not a branch ref (`refs/heads/*`)           → `[]`
 *     (tag pushes and other ref namespaces are out of M0
 *     scope; they are *ignored*, never silently coerced);
 *   - repository full name missing                        → `[]`
 *     (cannot build immutable commit URL evidence);
 *   - an individual commit with a zero/empty SHA, a missing
 *     timestamp, or an unparseable timestamp is dropped;
 *     the remaining well-formed commits are still emitted
 *     (defensive input cleaning, not a silent success —
 *     the red line forbids fabricated or empty-array
 *     stand-ins, not dropping genuinely malformed sub-items).
 *
 * Redaction (AGENTS.md §5.3): the per-event `payload` emitted here is
 * already redacted via `stripPrivateTags`, because `connector-storage.ts`
 * stores whatever the producer gives it verbatim and computes the N1
 * payload hash over the (assumed-redacted) content. The ingestion layer
 * strips again before persist — that re-strip is idempotent; the upstream
 * strip here guarantees no pre-redaction content ever leaves the producer.
 *
 * This module has no I/O and no database dependency; it is a pure,
 * replay-stable normalizer. Determinism is required by the CLI acceptance
 * criterion: parsing the same fixture twice must produce identical
 * normalized identity (deliveryId + itemKey + hash-eligible fields).
 */
import { z } from 'zod';
import { isoDateTime } from '@teamem/schema';
import { stripPrivateTags } from '../../security/private-tags.js';
import type { ActorProvenance, OccurredAtProvenance } from '@teamem/schema';
import type { NormalizedActor, NormalizedEvent } from '../registry.js';
import {
  extractRepositoryFullName,
  githubCommitUrl,
  githubOccurredAtProvenance,
  normalizeGithubActor,
} from './common.js';

// ── Public options ───────────────────────────────────────────────────────────

export interface NormalizePushInput {
  /** The `X-GitHub-Delivery` uuid for this one delivery (shared by all commits). */
  deliveryId: string;
  /** Raw parsed GitHub `push` payload (after JSON.parse, before redaction). */
  payload: Record<string, unknown>;
  /**
   * Whether the webhook signature was verified. Only verified deliveries
   * produce `actorProvenance: 'webhook_verified'` (contract N2).
   * Defaults to `true` — this is a GitHub *webhook* normalizer; callers
   * that somehow receive an unverified payload must pass `false`.
   */
  webhookVerified?: boolean;
}

// ── Internal raw-shape validators (defensive cross-boundary parsing) ─────────

const pushCommitAuthor = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const pushCommit = z
  .object({
    id: z.string().min(1), // commit SHA
    timestamp: z.string().min(1), // GitHub ISO 8601 commit timestamp
    url: z.string().optional(), // canonical commit URL provided by GitHub
    message: z.string().optional(),
    author: pushCommitAuthor.optional(),
    committer: pushCommitAuthor.optional(),
    distinct: z.boolean().optional(),
  })
  .passthrough();

const pushPayloadSchema = z
  .object({
    ref: z.string().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
    created: z.boolean().optional(),
    deleted: z.boolean().optional(),
    forced: z.boolean().optional(),
    repository: z.unknown().optional(),
    sender: z.unknown().optional(),
    commits: z.array(z.unknown()).optional(),
    head_commit: z.unknown().optional(),
    pusher: z.unknown().optional(),
  })
  .passthrough();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A 40-char (or 64-char) all-zeros SHA means "no commit" (deletion / new ref). */
const ZERO_SHA_REGEX = /^0+$/;

function isZeroSha(sha: string): boolean {
  return ZERO_SHA_REGEX.test(sha);
}

/** GitHub branch refs are the only push ref namespace supported in M0. */
const SUPPORTED_REF_PREFIX = 'refs/heads/';

function isSupportedBranchRef(ref: string | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(SUPPORTED_REF_PREFIX);
}

/**
 * Normalize a GitHub commit timestamp (e.g. `2024-01-15T20:30:00Z`,
 * `2024-01-15T20:30:00+00:00`, or `2024-01-15T20:30:00.000Z`) to the
 * frozen contract timestamp format: UTC `Z`, fixed 3-digit millisecond
 * precision ISO 8601 (N8). `Date#toISOString()` yields exactly that form.
 *
 * Returns `null` for unparseable input — the caller drops such commits
 * rather than fabricating a time.
 */
function normalizeCommitTimestamp(raw: string): string | null {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Asserts a string is a contract-valid UTC millisecond timestamp. */
function isValidContractTimestamp(value: string): boolean {
  return isoDateTime.safeParse(value).success;
}

/**
 * Splits the repository full name `owner/name` into its parts. Returns
 * `null` when the name cannot be split into exactly two non-empty parts.
 */
function splitRepositoryFullName(fullName: string): { owner: string; repo: string } | null {
  const idx = fullName.indexOf('/');
  if (idx <= 0 || idx >= fullName.length - 1) return null;
  const owner = fullName.slice(0, idx);
  const repo = fullName.slice(idx + 1);
  return { owner, repo };
}

// ── Main normalizer ──────────────────────────────────────────────────────────

/**
 * Normalize a GitHub `push` delivery into one {@link NormalizedEvent} per
 * commit. Returns `[]` for unsupported/deleted/noise deliveries (see the
 * file header) — these are *ignored*, never coerced into fabricated events.
 */
export function normalizePushEvent(input: NormalizePushInput): NormalizedEvent[] {
  const deliveryId = input.deliveryId;
  if (typeof deliveryId !== 'string' || deliveryId.trim() === '') {
    // No delivery id means we cannot build idempotent identity (N1).
    // The connector caller rejects this before reaching us; return nothing
    // rather than emit events with a fabricated id.
    return [];
  }

  const parsed = pushPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    // A push payload that doesn't even match the loose subset is noise to
    // ignore — the webhook handler skips it instead of crashing.
    return [];
  }
  const data = parsed.data;

  // Noise filter #1: explicit deletion.
  if (data.deleted === true) return [];

  // Noise filter #2: `after` is all-zeros → ref is being deleted even if
  // `deleted` wasn't set (defensive; GitHub always sets both together, but
  // we must not rely on undocumented invariants for idempotent identity).
  if (typeof data.after === 'string' && isZeroSha(data.after)) return [];

  // Noise filter #3: only branch refs are supported in M0. Tag pushes and
  // other ref namespaces are ignored — never silently coerced.
  if (!isSupportedBranchRef(data.ref)) return [];

  // Noise filter #4: repository identity is required to build the immutable
  // commit URL evidence; without it we cannot produce a trustworthy event.
  const repoFullName = extractRepositoryFullName(input.payload);
  if (!repoFullName) return [];
  const repoParts = splitRepositoryFullName(repoFullName);
  if (!repoParts) return [];
  const { owner, repo } = repoParts;

  // Actor claim (N2): null when absent — never fabricated.
  const actor: NormalizedActor | null = normalizeGithubActor(
    data.sender as Record<string, unknown> | undefined,
  );
  const webhookVerified = input.webhookVerified ?? true;
  const actorProvenance: ActorProvenance = webhookVerified ? 'webhook_verified' : 'unknown';

  const commitsRaw = Array.isArray(data.commits) ? data.commits : [];
  if (commitsRaw.length === 0) {
    // A push with zero commits (e.g. a force-push that GitHub reports with
    // an empty `commits` array) produces no events. We do not fabricate a
    // synthetic "head" event.
    return [];
  }

  const events: NormalizedEvent[] = [];
  for (const commitRaw of commitsRaw) {
    const commit = pushCommit.safeParse(commitRaw);
    if (!commit.success) continue;

    const sha = commit.data.id;
    if (isZeroSha(sha)) continue;

    const occurredAt = normalizeCommitTimestamp(commit.data.timestamp);
    if (occurredAt === null) continue;
    if (!isValidContractTimestamp(occurredAt)) continue;

    const occurredAtProvenance: OccurredAtProvenance =
      githubOccurredAtProvenance(true); // commit.timestamp is a provider fact (N8)

    // Immutable evidence URL — computed canonically, never trusted from the
    // raw payload field (the `url` field from GitHub is also canonical, but
    // computing it ourselves keeps the evidence fact self-validating and
    // independent of payload shape drift).
    const commitUrl = githubCommitUrl(owner, repo, sha);

    // Per-event payload: the commit + push-level context, redacted before it
    // leaves the producer (AGENTS.md §5.3). `before`/`after` are immutable
    // push-level SHAs preserved as evidence facts alongside the commit.
    const payload = stripPrivateTags({
      ref: data.ref,
      repository: { fullName: repoFullName, owner, name: repo },
      sha,
      message: commit.data.message,
      author: commit.data.author,
      committer: commit.data.committer,
      timestamp: commit.data.timestamp,
      distinct: commit.data.distinct,
      before: data.before,
      after: data.after,
      forced: data.forced,
      created: data.created,
      deleted: data.deleted,
      headCommitSha: typeof data.after === 'string' && !isZeroSha(data.after) ? data.after : null,
    });

    const event: NormalizedEvent = {
      connectorKind: 'github',
      eventKind: 'github_commit', // closed SourceKind — built-in github channel
      sourceEvent: 'push', // raw GitHub event name (Q6)
      deliveryId,
      itemKey: sha, // commit SHA = stable sub-item id (N1)
      externalId: `${repoFullName}@${sha}`, // human-meaningful ref
      url: commitUrl, // immutable commit evidence URL
      actor,
      actorProvenance,
      occurredAt,
      occurredAtProvenance,
      payload,
    };
    events.push(event);
  }

  return events;
}