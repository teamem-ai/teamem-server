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
 * - `z.strictObject` rejects unknown fields so model-hallucinated keys like
 *   `uuid`, `evidence`, or `createdAt` fail validation rather than being
 *   silently dropped — catching fabrication at the schema boundary.
 * - `targetConceptId` is `null` when `unrelated`; the LLM must not invent
 *   a target when none exists.
 * - `mergedTitle` / `mergedBody` are the rewritten, evidence-merged text
 *   that incorporates the new knowledge into the existing concept body
 *   (or passes through for unrelated/new concepts).
 * - `resultStatus` enforces the red-line rule: contradictory evidence
 *   changes `status` to `disputed`, never merely lowers `confidence` (§5.2).
 *   The refinement (`.superRefine`) mechanically rejects any contradicts
 *   decision that does not set resultStatus to "disputed".
 */
import { z } from 'zod';
import { conceptUuid, conceptStatus } from '@teamem/schema';

// ── Relationship discriminant ──────────────────────────────────────────────
export const f2Relationship = z.enum([
  'confirms',
  'extends',
  'contradicts',
  'unrelated',
]);
export type F2Relationship = z.infer<typeof f2Relationship>;

// ── F2 merge decision ──────────────────────────────────────────────────────
export const f2Decision = z
  .strictObject({
    /** How the new knowledge relates to the existing concept */
    relationship: f2Relationship,
    /** UUID of the target concept; null when relationship is "unrelated" */
    targetConceptId: conceptUuid.nullable(),
    /** Rewritten title incorporating the new evidence */
    mergedTitle: z.string().min(1).max(500),
    /** Rewritten body incorporating the new evidence (markdown) */
    mergedBody: z.string().min(1),
    /**
     * The concept status after merging.
     * Red line: contradictory evidence → "disputed" (not a confidence cut).
     * Enforced mechanically by the refinement below.
     */
    resultStatus: conceptStatus,
  })
  .superRefine((data, ctx) => {
    // Contradictory evidence MUST change status to disputed — never merely
    // lower confidence (§5.2 red line).
    if (
      data.relationship === 'contradicts' &&
      data.resultStatus !== 'disputed'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'resultStatus must be "disputed" when relationship is "contradicts"',
        path: ['resultStatus'],
      });
    }

    // When unrelated, targetConceptId must be null — there is no target.
    if (
      data.relationship === 'unrelated' &&
      data.targetConceptId !== null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'targetConceptId must be null when relationship is "unrelated"',
        path: ['targetConceptId'],
      });
    }

    // When confirms, extends, or contradicts, targetConceptId must be non-null.
    if (
      data.relationship !== 'unrelated' &&
      data.targetConceptId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `targetConceptId must not be null when relationship is "${data.relationship}"`,
        path: ['targetConceptId'],
      });
    }
  });

/** F2 merge decision — validated after every LLM call */
export type F2Decision = z.infer<typeof f2Decision>;
