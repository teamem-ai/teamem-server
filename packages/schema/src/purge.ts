/**
 * Purge DTOs. (Contract v0.2 Appendix A — v0.3 additive, DUA-228.)
 *
 * Project-level purge response: returns deletion counts for every
 * project-scoped table. The purge endpoint is a management (web-session)
 * endpoint, not a v1 API endpoint, but the response DTO lives here for
 * consistency with the frozen-contract rule that every cross-boundary
 * input/output must pass through Zod validation.
 */
import { z } from 'zod';
import { projectId, requestId } from './common.js';

/**
 * Response shape for POST /teams/:teamId/projects/:projectId/purge.
 *
 * Each count is the number of rows deleted from that table, scoped to
 * the project. auditLog and principals are deliberately excluded — they
 * survive the purge by design (N7).
 */
export const purgeResponse = z.strictObject({
  requestId,
  projectId,
  eventsDeleted: z.number().int().min(0),
  conceptsDeleted: z.number().int().min(0),
  conceptPathsDeleted: z.number().int().min(0),
  conceptEvidenceDeleted: z.number().int().min(0),
  conceptContributorsDeleted: z.number().int().min(0),
  jobsDeleted: z.number().int().min(0),
  jobEventsDeleted: z.number().int().min(0),
});
export type PurgeResponse = z.infer<typeof purgeResponse>;
