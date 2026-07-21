/**
 * F2 structured output contract — the LLM's merge-decision shape.
 *
 * F2 decides whether a new piece of knowledge (F1-extracted candidate)
 * confirms, extends, or contradicts an existing concept, or is entirely
 * unrelated and should become a new concept page. The model provides ONLY
 * semantic judgment; all server-owned facts (UUID, timestamps, evidence,
 * actor, provenance, schemaVersion) are supplied by the compiler after
 * validation.
 *
 * Design rationale:
 * - `relationship` is a four-value discriminator covering the full merge
 *   decision space: confirms (corroborates existing), extends (adds new
 *   detail), contradicts (conflicting evidence), unrelated (new concept).
 * - Each branch is a `z.strictObject` inside `z.discriminatedUnion`, so:
 *   - unknown fields are rejected (hallucinated `uuid`, `evidence`, etc.
 *     fail at the schema boundary);
 *   - TypeScript narrows `targetConceptId` correctly per branch (`string`
 *     for confirms/extends/contradicts, `null` for unrelated);
 *   - the "contradicts → disputed" red line is encoded in the type itself
 *     (`resultStatus` is `z.literal('disputed')` on the contradicts branch),
 *     so an LLM that returns contradicts with any other status fails base
 *     parsing before cross-field refinements.
 * - `mergedTitle` is capped at 500 chars; `mergedBody` is capped at 50 000
 *   chars to gate runaway output at the schema boundary.
 */
import { z } from 'zod';
import { conceptUuid, conceptStatus } from '@teamem/schema';

// ── Shared fields across all branches ──────────────────────────────────────
const mergedFields = {
  mergedTitle: z.string().min(1).max(500),
  mergedBody: z.string().min(1).max(50_000),
} as const;

// ── Relationship discriminant ──────────────────────────────────────────────
export const f2Relationship = z.enum([
  'confirms',
  'extends',
  'contradicts',
  'unrelated',
]);
export type F2Relationship = z.infer<typeof f2Relationship>;

// ── Four branches: discriminated on `relationship` ─────────────────────────
const confirmsBranch = z.strictObject({
  relationship: z.literal('confirms'),
  targetConceptId: conceptUuid,
  resultStatus: conceptStatus,
  ...mergedFields,
});

const extendsBranch = z.strictObject({
  relationship: z.literal('extends'),
  targetConceptId: conceptUuid,
  resultStatus: conceptStatus,
  ...mergedFields,
});

const contradictsBranch = z.strictObject({
  relationship: z.literal('contradicts'),
  targetConceptId: conceptUuid,
  // Red line (§5.2): contradictory evidence changes status to disputed —
  // never merely lower confidence. Encoded as a literal so the type system
  // enforces it.
  resultStatus: z.literal('disputed'),
  ...mergedFields,
});

const unrelatedBranch = z.strictObject({
  relationship: z.literal('unrelated'),
  targetConceptId: z.null(),
  resultStatus: conceptStatus,
  ...mergedFields,
});

/**
 * The full F2 merge-decision schema — a discriminated union validated after
 * every LLM call. Validation failure is an explicit compilation failure; the
 * compiler retries or routes to review (§5.2 red line: never loosely accept
 * "approximately correct" output).
 *
 * Each branch encodes its own invariants in the type:
 * - confirms/extends/contradicts → targetConceptId is the existing UUID
 * - contradicts → resultStatus is always "disputed"
 * - unrelated → targetConceptId is null (new concept incoming)
 */
export const f2Decision = z.discriminatedUnion('relationship', [
  confirmsBranch,
  extendsBranch,
  contradictsBranch,
  unrelatedBranch,
]);

/** F2 merge decision — validated after every LLM call */
export type F2Decision = z.infer<typeof f2Decision>;
