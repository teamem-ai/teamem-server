/**
 * F1 structured output contract — the LLM's return shape.
 *
 * F1 extracts a minimal candidate concept (or an explicit skip) from an
 * ingested event. The model provides ONLY semantic content; all server-owned
 * facts (UUID, timestamps, evidence, actor, provenance, schemaVersion) are
 * supplied by the compiler after validation.
 *
 * Design rationale:
 * - Discriminated union on `action` gives two clean branches: extract or skip.
 * - `z.strictObject` rejects unknown fields so model-hallucinated keys like
 *   `uuid`, `evidence`, or `createdAt` fail validation rather than being
 *   silently dropped — catching fabrication at the schema boundary.
 * - The prompt (prompt.ts) explicitly instructs the model not to produce
 *   server-owned fields; the schema enforces it mechanically.
 * - `status` is intentionally omitted from the extract shape: for M0, new
 *   concepts start as `active`; status transitions are compiler business
 *   logic, not LLM output.
 */
import { z } from 'zod';
import {
  conceptPath,
  conceptType,
  confidence,
} from '@teamem/schema';

// ── Extract branch: a candidate concept the model believes is supported ────
const extractOutput = z.strictObject({
  action: z.literal('extract'),
  type: conceptType,
  title: z.string().min(1).max(500),
  body: z.string().min(1),
  path: conceptPath,
  tags: z.array(z.string()),
  confidence: confidence,
});

// ── Skip branch: the model found no extractable knowledge ──────────────────
const skipOutput = z.strictObject({
  action: z.literal('skip'),
  reason: z.string().min(1).max(500),
});

/**
 * The full F1 output schema — a discriminated union validated after every
 * LLM call. Validation failure is an explicit compilation failure; the
 * compiler retries or routes to review (§5.2 red line: never loosely accept
 * "approximately correct" output).
 */
export const f1Output = z.discriminatedUnion('action', [extractOutput, skipOutput]);
export type F1Output = z.infer<typeof f1Output>;
export type F1ExtractOutput = z.infer<typeof extractOutput>;
export type F1SkipOutput = z.infer<typeof skipOutput>;
