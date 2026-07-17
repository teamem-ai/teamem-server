/**
 * Stored event DTOs. (Contract v0.2 Appendix A — N2/N7/N8.)
 */
import { z } from 'zod';
import { actor, actorProvenance, ingestedBy, occurredAtProvenance } from './actor.js';
import {
  eventId,
  isoDateTime,
  itemResponse,
  listLimit,
  listResponse,
  projectId,
} from './common.js';
import { source, sourceKind } from './source.js';

/**
 * List item — summary only (N7: raw payload never appears in lists; GitHub
 * payloads can contain unmarked sensitive content).
 */
export const eventSummary = z.strictObject({
  id: eventId,
  projectId,
  source,
  actor: actor.nullable(),
  actorProvenance,
  occurredAt: isoDateTime, // source-event time — display on timelines (N8)
  occurredAtProvenance,
  ingestedBy,
  payloadBytes: z.number().int().min(0),
  createdAt: isoDateTime, // server ingest time — sorting/cursor/audit (N8)
});
export type EventSummary = z.infer<typeof eventSummary>;

/**
 * Detail served by GET /v1/events/:id — requires the `read:payload` scope,
 * every read is audited, and the payload is the POST-strip stored content:
 * no queryable pre-strip version exists anywhere in the system (N7).
 */
export const eventDetail = eventSummary.extend({
  payload: z.record(z.string(), z.unknown()),
});
export type EventDetail = z.infer<typeof eventDetail>;

/** Query params for GET /v1/events. Sort: created_at desc (N8). */
export const eventListQuery = z.strictObject({
  projectId,
  sourceKind: sourceKind.optional(),
  cursor: z.string().optional(),
  limit: listLimit,
});

// ── Named endpoint response DTOs (N3) ───────────────────────────────────────
export const eventListResponse = listResponse(eventSummary);
export const eventDetailResponse = itemResponse(eventDetail);
