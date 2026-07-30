/**
 * SessionStart context injection DTOs. (Contract v0.3 additive — M2-GOV-03.)
 *
 * GET /v1/context?projectId=... returns a token-budget-controlled markdown
 * summary of recent high-confidence concept pages for agent SessionStart
 * auto-injection. The endpoint has its own value/confidence/freshness
 * budget strategy (not simply reusing the concepts list ordering).
 */
import { z } from 'zod';
import { projectId, requestId } from './common.js';

// ── Request ─────────────────────────────────────────────────────────────────
/** Query parameters for GET /v1/context. */
export const contextRequest = z.strictObject({
  projectId,
});
export type ContextRequest = z.infer<typeof contextRequest>;

// ── Response ────────────────────────────────────────────────────────────────
/**
 * A token-budget-controlled markdown summary for SessionStart injection.
 *
 * - `markdown`: rendered markdown with title + one-line summary + teamem:// links.
 *   Empty string when no high/medium-confidence concepts exist.
 * - `budgetUsed`: approximate token count of `markdown` (≈ chars/4).
 * - `conceptsIncluded`: number of concept pages included in this summary.
 * - `conceptsAvailable`: total number of high/medium-confidence concept pages
 *   in the project (for the caller to understand coverage).
 */
export const contextResponse = z.strictObject({
  requestId,
  data: z.strictObject({
    markdown: z.string(),
    budgetUsed: z.number().int().min(0),
    conceptsIncluded: z.number().int().min(0),
    conceptsAvailable: z.number().int().min(0),
  }),
});
export type ContextResponse = z.infer<typeof contextResponse>;
