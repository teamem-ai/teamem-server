/**
 * Ingestion API DTOs. (Contract v0.2 Appendix A — contract ② + Q8/N1/N2/N8.)
 *
 * Pipeline order is part of the contract: validate → stripPrivateTags →
 * persist → enqueue. `payload_hash = sha256(canonical_json(stripped payload))`
 * (canonical = sorted keys, no whitespace, UTF-8) — computed on the STORED
 * content so a retry of the same original payload yields the same hash (N1).
 */
import { z } from 'zod';
import { actor } from './actor.js';
import {
  conceptUuid,
  eventId,
  isoDateTime,
  jobId,
  projectId,
  requestId,
  PAYLOAD_SCHEMA_VERSION,
} from './common.js';
import { sourceInput } from './source.js';
import { conceptType } from './concept.js';

// ── Per-kind payloads (public channel: cli_init; mcp channel: mcp_write) ───
export const cliInitPayload = z.strictObject({
  schemaVersion: z.literal(PAYLOAD_SCHEMA_VERSION),
  repo: z.string().min(1), // "org/repo"
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/), // snapshot anchor (immutable)
  path: z.string().min(1),
  content: z.string(),
  truncated: z.boolean().optional(),
});
export type CliInitPayload = z.infer<typeof cliInitPayload>;

/** Validated by the MCP endpoint against `memory_write` tool arguments. */
export const mcpWritePayload = z.strictObject({
  schemaVersion: z.literal(PAYLOAD_SCHEMA_VERSION),
  title: z.string().optional(),
  text: z.string().min(1),
  suggestedType: conceptType.optional(),
  tags: z.array(z.string()).optional(),
});
export type McpWritePayload = z.infer<typeof mcpWritePayload>;

// ── POST /v1/events (public REST channel) ───────────────────────────────────
export const ingestOptions = z.strictObject({
  compile: z.boolean().default(true), // false → store only, no job (Q8)
  wait: z.boolean().default(false), // true → sync wait up to 30s (Q8)
});

export const ingestEventRequest = z.strictObject({
  projectId,
  source: sourceInput, // public channel accepts cli_init only (see source.ts)
  actor: actor.nullable().optional(), // recorded as client_claimed (N2)
  occurredAt: isoDateTime.optional(), // recorded as client provenance (N8)
  payload: cliInitPayload,
  idempotencyKey: z.string().min(8).max(200), // REQUIRED — content hash of
  // (repo + commitSha + path) so re-running init dedups naturally (N1)
  options: ingestOptions.default({ compile: true, wait: false }),
});
export type IngestEventRequest = z.infer<typeof ingestEventRequest>;

/**
 * Response for POST /v1/events. HTTP status semantics (Q8/N1):
 * - 202 default: `{ eventId, jobId }` (jobId null when compile=false)
 * - 200 wait=true completed: `{ eventId, jobId, conceptIds }`
 * - 202 wait=true timed out (30s): `{ eventId, jobId, timedOut: true }`
 * - 200 duplicate replay: original result + `duplicate: true`
 * - 409 idempotency_conflict: same key, different payload hash (error envelope)
 */
export const ingestEventResponse = z.strictObject({
  requestId,
  eventId,
  jobId: jobId.nullable(),
  conceptIds: z.array(conceptUuid).optional(),
  duplicate: z.boolean().default(false),
  timedOut: z.boolean().optional(),
});
export type IngestEventResponse = z.infer<typeof ingestEventResponse>;

// ── POST /v1/events/batch (≤500 items, 5MB body cap; one batch = one compile
//    job — F2 merging needs cross-item context) ─────────────────────────────
export const batchItem = z.strictObject({
  source: sourceInput,
  actor: actor.nullable().optional(),
  occurredAt: isoDateTime.optional(),
  payload: cliInitPayload,
  itemKey: z.string().min(1), // stable sub-item id within the batch (N1)
});

export const ingestBatchRequest = z.strictObject({
  projectId,
  idempotencyKey: z.string().min(8).max(200), // batch-level key: a timed-out
  // retry must return the same batchJobId (N1)
  events: z.array(batchItem).min(1).max(500),
  options: z
    .strictObject({ compile: z.boolean().default(true) })
    .default({ compile: true }),
});
export type IngestBatchRequest = z.infer<typeof ingestBatchRequest>;

/** Plain 200 with per-item results — no HTTP 207 (N3). Non-atomic, partial success. */
export const batchItemResult = z.strictObject({
  index: z.number().int().min(0),
  status: z.enum(['accepted', 'rejected', 'duplicate']),
  eventId: eventId.optional(),
  error: z
    .strictObject({ code: z.string(), message: z.string() })
    .optional(),
});

export const ingestBatchResponse = z.strictObject({
  requestId,
  batchJobId: jobId.nullable(), // null when compile=false
  duplicate: z.boolean().default(false),
  results: z.array(batchItemResult),
});
export type IngestBatchResponse = z.infer<typeof ingestBatchResponse>;

// ── POST /v1/compilations (N1: compile trigger for stored-only events; a ───
//    WRITE endpoint — lives in contract ②, not the read-only contract ③) ────
export const compilationRequest = z.strictObject({
  projectId,
  eventIds: z.array(eventId).min(1).max(500),
  idempotencyKey: z.string().min(8).max(200), // required — same key returns
  // the original compilationJobId (N1)
});
export type CompilationRequest = z.infer<typeof compilationRequest>;

export const compilationItemStatus = z.enum([
  'queued',
  'already_active', // event already in an active job — skipped
  'already_compiled', // no forced recompile in MVP (V1.1 topic)
  'not_found',
]);

export const compilationResponse = z.strictObject({
  requestId,
  compilationJobId: jobId,
  duplicate: z.boolean().default(false),
  results: z.array(
    z.strictObject({ eventId, status: compilationItemStatus }),
  ),
});
export type CompilationResponse = z.infer<typeof compilationResponse>;
