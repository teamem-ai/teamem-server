/**
 * Job DTOs. (Contract v0.2 Appendix A — N3/N4/N6.)
 */
import { z } from 'zod';
import {
  conceptUuid,
  credentialId,
  eventId,
  isoDateTime,
  jobId,
  listLimit,
  listResponse,
  principalId,
  projectId,
  requestId,
} from './common.js';

/** N3: unified job lifecycle (replaces the older "pending → done" wording). */
export const jobStatus = z.enum([
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof jobStatus>;

/**
 * N6 worker attribution: every job records what initiated it and runs under
 * the initiator's ScopeContext — background writes trace back to a cause.
 */
export const jobInitiator = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('credential'),
    credentialId,
    principalId: principalId.nullable(),
  }),
  z.strictObject({
    kind: z.literal('connector'),
    connector: z.enum(['github']),
  }),
]);
export type JobInitiator = z.infer<typeof jobInitiator>;

/**
 * Per-event outcome inside a (batch) job — a discriminated union so each
 * state carries exactly its own facts: results for compiled, a reason for
 * skipped, a sanitized error for failed. Nothing optional-and-ambiguous.
 */
export const jobEventResult = z.discriminatedUnion('status', [
  z.strictObject({ eventId, status: z.literal('pending') }),
  z.strictObject({
    eventId,
    status: z.literal('compiled'),
    conceptIds: z.array(conceptUuid), // result: pages touched by this event
  }),
  z.strictObject({
    eventId,
    status: z.literal('skipped'),
    reason: z.enum(['no_knowledge', 'already_compiled']), // additive registry
  }),
  z.strictObject({
    eventId,
    status: z.literal('failed'),
    error: z.strictObject({ code: z.string(), message: z.string() }), // sanitized
  }),
]);
export type JobEventResult = z.infer<typeof jobEventResult>;

/**
 * Job detail (GET /v1/jobs/:id — id is a UUID, N4). `error` is sanitized:
 * never contains raw payloads, prompts, or provider responses (N3/N7).
 */
export const job = z.strictObject({
  id: jobId,
  projectId,
  status: jobStatus,
  attempts: z.number().int().min(0),
  initiatedBy: jobInitiator,
  eventCount: z.number().int().min(1),
  events: z.array(jobEventResult).optional(), // batch job detail (N4)
  conceptIds: z.array(conceptUuid).optional(), // present when completed
  error: z
    .strictObject({ code: z.string(), message: z.string() })
    .optional(), // present when failed — sanitized
  createdAt: isoDateTime,
  startedAt: isoDateTime.optional(),
  finishedAt: isoDateTime.optional(),
});
export type Job = z.infer<typeof job>;

export const jobDetailResponse = z.strictObject({ requestId, data: job });
export const jobListItem = job.omit({ events: true });

/** Query params for GET /v1/jobs. Sort: created_at desc (N8). */
export const jobListQuery = z.strictObject({
  projectId,
  status: jobStatus.optional(),
  cursor: z.string().optional(),
  limit: listLimit,
});

/** Named endpoint response DTO for GET /v1/jobs (N3). */
export const jobListResponse = listResponse(jobListItem);
