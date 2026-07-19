/**
 * Recursive private-tag redaction (AGENTS.md §5.3).
 *
 * Removes complete `<private>...</private>` sections from every string field
 * in an arbitrarily nested object or array.  The function is pure / immutable:
 * the original input is never mutated; a shallow-copied tree with cleaned
 * strings is returned.
 *
 * Scan strategy — linear O(n) walk, no regex:
 *   1. Find the next `<private>` (ASCII 60,112,114,105,118,97,116,101,62).
 *   2. From that position find the next `</private>`.
 *   3. Remove the matched region; resume scanning after the closing tag.
 *   4. If no closing tag is found, remove from the opening tag to end of
 *      string (conservative: better to over-redact than leak).
 *   5. Repeat until the whole string is processed.
 *
 * The markers are exact case-sensitive ASCII — no HTML-entity or Unicode
 * variants are treated as tags.  "Nested" occurrences like
 * `<private><private>x</private></private>` are handled naturally: the
 * first `<private>` opens, the first `</private>` closes, and everything
 * between (including inner literal `<private>` text) is removed.
 */

// ── String-level redaction ──────────────────────────────────────────────────

const OPEN = '<private>';
const CLOSE = '</private>';

/**
 * Strip all `<private>…</private>` regions from `input` using a linear scan.
 * No regex is used, so there is no catastrophic backtracking risk.
 */
function stripString(input: string): string {
  const openLen = OPEN.length;
  const closeLen = CLOSE.length;
  const len = input.length;
  let result = '';
  let cursor = 0;

  while (cursor < len) {
    const openIdx = input.indexOf(OPEN, cursor);
    if (openIdx === -1) {
      // No more tags — append the rest verbatim.
      result += input.slice(cursor);
      break;
    }

    // Append everything before the opening tag.
    result += input.slice(cursor, openIdx);

    // Find the matching close tag starting right after the open tag.
    const closeIdx = input.indexOf(CLOSE, openIdx + openLen);
    if (closeIdx === -1) {
      // No closing tag — conservative: remove from open tag to end of string.
      break;
    }

    // Advance cursor past the closing tag for the next iteration.
    cursor = closeIdx + closeLen;
  }

  return result;
}

// ── Recursive tree traversal ────────────────────────────────────────────────

/**
 * Recursively walk `value` and strip `<private>…</private>` from every string.
 * Objects and arrays are shallow-copied; primitives other than string are
 * returned as-is.  The original input is never mutated.
 */
export function stripPrivateTags<T>(value: T): T {
  if (typeof value === 'string') {
    return stripString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map(stripPrivateTags) as T;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = stripPrivateTags((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }

  // number, boolean, null, undefined — pass through unchanged.
  return value;
}
