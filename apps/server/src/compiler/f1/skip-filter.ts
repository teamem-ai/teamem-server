/**
 * F1 deterministic skip filter — pre-LLM noise gate.
 *
 * Before calling the LLM for structured extraction, this module runs a set
 * of cheap, deterministic checks on the event payload to detect noise that
 * clearly has no extractable team knowledge. Events that match a noise
 * pattern are immediately marked as skipped with a specific reason, saving
 * LLM tokens and latency.
 *
 * Design:
 * - Pure function — no side effects, no database, no LLM call.
 * - Returns `null` when the filter cannot determine the event is noise;
 *   the caller falls through to the LLM for a full decision.
 * - Returns `F1SkipOutput` (the same shape the LLM would produce) when a
 *   noise pattern is matched, with a specific, human-readable reason.
 * - The skip output must still pass the `f1Output` Zod schema — the reason
 *   is required and bounded to 500 chars.
 *
 * Noise categories:
 *   1. Meaningless commit messages (single-word, emoji-only, whitespace).
 *   2. Automated dependency bumps (Dependabot, Renovate).
 *   3. Auto-generated merge commits.
 *   4. Vague updates with no substance.
 *   5. Version-only tags.
 */

import type { F1SkipOutput } from './output.js';

// ── Noise patterns ─────────────────────────────────────────────────────────

/**
 * Commit messages that are trivially meaningless.
 *
 * These are single words (or emoji-only) with zero semantic content.
 * A team member would never search for these or learn anything from them.
 */
const MEANINGLESS_COMMIT_PATTERNS = [
  /^\.$/,
  /^[\s.]*$/,
  /^🚀$/,
  /^[🚀🔥💚✅🐛🎉🔧📝⚡️]+$/,
];

const MEANINGLESS_COMMIT_EXACT = new Set([
  'asdf',
  'wip',
  'test',
  'tmp',
  'fix',
  'fixes',
  'update',
  'updates',
  'misc',
  'foo',
  'bar',
  'todo',
  'commit',
  'save',
  'work',
]);

/**
 * Commit messages that are too vague to contain reusable knowledge.
 *
 * Split into two groups to avoid skipping substantive messages that
 * merely *start* with a vague prefix:
 *
 *  1. EXACT patterns (anchored with `$`) — always skip. The entire
 *     message is irredeemably vague regardless of length.
 *  2. PREFIX patterns (no `$` anchor) — only skip when the message is
 *     short (< 60 chars). A longer message with the same prefix may
 *     contain real rationale (e.g., "fix typo in the rate-limiter
 *     design after analyzing token-bucket trade-offs").
 */

/** Max length for a prefix-matched vague message to be auto-skipped. */
const VAGUE_PREFIX_MAX_LENGTH = 60;

/** Exact-match vague patterns — always skip. */
const VAGUE_COMMIT_EXACT = [
  /^typo$/i,
  /^format$/i,
  /^lint$/i,
  /^cleanup$/i,
  /^clean ?up$/i,
  /^refactor$/i,
  /^update readme$/i,
  /^update docs$/i,
  /^update changelog$/i,
  /^update license$/i,
  /^update .gitignore$/i,
  /^fix tests?$/i,
  /^fix build$/i,
  /^fix ci$/i,
];

/**
 * Vague prefix patterns — only skip when message is < 60 chars.
 * Longer messages with these prefixes may contain real rationale.
 */
const VAGUE_COMMIT_PREFIX = [
  /^fix typo/i,
  /^fix typo in /i,
  /^fix lint/i,
  /^fix format/i,
  /^code review/i,
  /^review feedback/i,
  /^pr feedback/i,
  /^address comments/i,
  /^address review/i,
];

/**
 * Patterns that indicate an automated dependency bump.
 */
const DEPENDABOT_PATTERNS = [
  /^bump /i,
  /^build\(deps\)/i,
  /^chore\(deps\)/i,
  /dependabot/i,
  /renovate/i,
  /^update dependency/i,
  /^upgrade dependency/i,
  /bumps? .+ from/i,
];

/**
 * Patterns that indicate an auto-generated merge commit.
 */
const MERGE_COMMIT_PATTERNS = [
  /^merge branch '/i,
  /^merge pull request #/i,
  /^merge remote-tracking branch/i,
];

/**
 * Version-only tags.
 */
const VERSION_ONLY_PATTERN = /^v?\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

/**
 * Linter/formatter config changes with no team discussion.
 */
const MECHANICAL_PR_TITLE_PATTERNS = [
  /^chore\(?(deps|dev)\)?:?\s*bump/i,
  /^chore:?\s*update eslint/i,
  /^chore:?\s*update prettier/i,
  /^chore:?\s*update .*config/i,
  /^style:?\s*apply (prettier|lint|format)/i,
];

// ── Detection helpers ──────────────────────────────────────────────────────

/**
 * Truncate and quote a string for use in a skip reason.
 *
 * Reasons must fit within the 500-char Zod bound on `F1SkipOutput.reason`.
 * The longest static prefix is ~60 chars, so we cap the interpolated
 * payload excerpt at 200 chars.
 */
function truncForReason(s: string): string {
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

/**
 * Check whether a commit message is noise.
 *
 * Returns a skip reason string if noise is detected, or `null` if the
 * message should be evaluated by the LLM.
 */
function checkCommitMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;

  const trimmed = message.trim();

  // Empty or whitespace-only.
  if (trimmed.length === 0) {
    return 'Empty commit message — no extractable knowledge';
  }

  // Single character or very short, meaningless.
  if (trimmed.length <= 2 && /^[^\w]+$/.test(trimmed)) {
    return `Meaningless commit message: "${truncForReason(trimmed)}"`;
  }

  // Meaningless exact matches.
  if (MEANINGLESS_COMMIT_EXACT.has(trimmed.toLowerCase())) {
    return `Meaningless commit message: "${truncForReason(trimmed)}"`;
  }

  // Meaningless patterns (emoji, dots, whitespace-only).
  for (const pattern of MEANINGLESS_COMMIT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `Meaningless commit message: "${truncForReason(trimmed)}"`;
    }
  }

  // Vague exact patterns — always skip (entire message matches).
  for (const pattern of VAGUE_COMMIT_EXACT) {
    if (pattern.test(trimmed)) {
      return `Vague commit message with no extractable knowledge: "${truncForReason(trimmed)}"`;
    }
  }

  // Vague prefix patterns — only skip when message is short.
  // Longer messages with these prefixes may contain real rationale
  // (e.g., "fix typo in the rate-limiter design after analyzing
  // token-bucket trade-offs"). Let the LLM evaluate those.
  if (trimmed.length < VAGUE_PREFIX_MAX_LENGTH) {
    for (const pattern of VAGUE_COMMIT_PREFIX) {
      if (pattern.test(trimmed)) {
        return `Vague commit message with no extractable knowledge: "${truncForReason(trimmed)}"`;
      }
    }
  }

  // Dependency bumps.
  for (const pattern of DEPENDABOT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `Automated dependency bump with no team decision: "${truncForReason(trimmed)}"`;
    }
  }

  // Merge commits.
  for (const pattern of MERGE_COMMIT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'Auto-generated merge commit with no extractable knowledge';
    }
  }

  // Version-only tags.
  if (VERSION_ONLY_PATTERN.test(trimmed)) {
    return `Version-only tag with no release notes: "${truncForReason(trimmed)}"`;
  }

  return null;
}

/**
 * Check whether a PR or issue title+body is noise.
 */
function checkPrIssue(
  title: unknown,
  body: unknown,
): string | null {
  const titleStr = typeof title === 'string' ? title.trim() : '';
  const bodyStr = typeof body === 'string' ? body.trim() : '';

  // Dependabot/Renovate PR: title starts with "Bump " or contains "dependabot".
  if (DEPENDABOT_PATTERNS.some((p) => p.test(titleStr))) {
    return `Automated dependency bump with no team decision: "${truncForReason(titleStr)}"`;
  }

  // Mechanical PR titles with no substantive body.
  if (MECHANICAL_PR_TITLE_PATTERNS.some((p) => p.test(titleStr))) {
    if (bodyStr.length < 100) {
      return `Mechanical configuration change with no team discussion: "${truncForReason(titleStr)}"`;
    }
  }

  // Empty body and vague title.
  if (bodyStr.length === 0) {
    if (/^(question|help|how|what|when|who|where)\b/i.test(titleStr)) {
      return null; // Could be a genuine question — let LLM decide.
    }
    if (titleStr.length < 20) {
      return `Vague issue/PR with empty body and short title: "${truncForReason(titleStr)}"`;
    }
  }

  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run deterministic noise checks on an event payload.
 *
 * Inspects the payload for well-known noise patterns and returns a skip
 * decision with a specific reason when the event clearly has no extractable
 * team knowledge.
 *
 * This filter is a first-pass gate: it only skips events that are
 * **obviously** noise. Borderline events pass through (`null` return) so
 * the LLM can make the final call.
 *
 * @param channel - Source channel (github, cli, mcp, external).
 * @param kind   - Parsed source kind (github_commit, github_pr, etc.).
 * @param payload - Redacted event payload.
 * @returns A valid skip output (matching F1SkipOutput), or null if the
 *          filter cannot determine the event is noise.
 */
export function prefilterNoise(
  channel: string,
  kind: string,
  payload: Record<string, unknown>,
): F1SkipOutput | null {
  // ── GitHub commits: check commit message ───────────────────────────
  if (channel === 'github' && kind === 'github_commit') {
    const reason = checkCommitMessage(payload['message']);
    if (reason) {
      return { action: 'skip', reason };
    }
  }

  // ── GitHub PRs: check title and body ───────────────────────────────
  if (channel === 'github' && kind === 'github_pr') {
    const reason = checkPrIssue(payload['title'], payload['body']);
    if (reason) return { action: 'skip', reason };

    // Also check the body for dependabot signature.
    const body = typeof payload['body'] === 'string' ? payload['body'] : '';
    if (/dependabot/i.test(body) || /renovate/i.test(body)) {
      const title = typeof payload['title'] === 'string' ? payload['title'] : 'Untitled';
      return {
        action: 'skip',
        reason: `Automated dependency bump (Dependabot/Renovate): "${truncForReason(title)}"`,
      };
    }
  }

  // ── GitHub issues: check for question-only with no content ─────────
  if (channel === 'github' && kind === 'github_issue') {
    const reason = checkPrIssue(payload['title'], payload['body']);
    if (reason) return { action: 'skip', reason };
  }

  // ── GitHub PR comments: check for very short comments ──────────────
  if (channel === 'github' && kind === 'github_pr_comment') {
    const body = typeof payload['body'] === 'string' ? payload['body'].trim() : '';
    if (body.length === 0) {
      return { action: 'skip', reason: 'Empty PR comment with no content' };
    }
    // Very short non-substantive comments.
    const shortBody = body.toLowerCase();
    if (
      shortBody === 'lgtm' ||
      shortBody === '👍' ||
      shortBody === '🚀' ||
      shortBody === 'ship it' ||
      shortBody === 'nice' ||
      shortBody === 'done' ||
      shortBody === 'fixed' ||
      shortBody === 'thanks' ||
      shortBody === 'thank you'
    ) {
      return { action: 'skip', reason: `Non-substantive PR comment: "${truncForReason(body)}"` };
    }
  }

  // ── CLI init payloads: check for empty content ─────────────────────
  if (kind === 'cli_init') {
    const content = typeof payload['content'] === 'string' ? payload['content'].trim() : '';
    if (content.length === 0) {
      return { action: 'skip', reason: 'CLI init with empty content — no extractable knowledge' };
    }
  }

  // ── Not noise — fall through to LLM ───────────────────────────────
  return null;
}
