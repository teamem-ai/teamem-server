/**
 * Common contract primitives: versions, IDs, timestamps, error envelope,
 * list envelope, cursor. (Contract v0.2 Appendix A — decisions N3/N8/Q11.)
 */
import { z } from 'zod';

// ── Versions (N8: four independent version tracks, never "corresponding") ──
export const API_VERSION = 'v1' as const;
export const EVENT_ENVELOPE_VERSION = 1 as const;
export const PAYLOAD_SCHEMA_VERSION = 1 as const;
export const CONCEPT_SCHEMA_VERSION = 1 as const;

// ── Timestamps (N8: UTC `Z`, fixed millisecond precision ISO 8601) ─────────
export const isoDateTime = z.iso.datetime({ precision: 3 });

// ── IDs ─────────────────────────────────────────────────────────────────────
// Rule: prefixed opaque IDs for API-created resources; plain UUIDs for jobs
// (N4: "id is a job UUID"), concepts (N5: uuid is the canonical identity),
// and audit entries (server-created records, same rationale as jobs).
export const teamId = z.string().regex(/^team_[A-Za-z0-9]+$/);
export const projectId = z.string().regex(/^prj_[A-Za-z0-9]+$/);
export const eventId = z.string().regex(/^evt_[A-Za-z0-9]+$/);
export const principalId = z.string().regex(/^pri_[A-Za-z0-9]+$/);
export const credentialId = z.string().regex(/^key_[A-Za-z0-9]+$/);
export const jobId = z.uuid();
export const conceptUuid = z.uuid();
export const auditId = z.uuid();
export const requestId = z.string().min(1);

// ── Error envelope (N3: stable machine-readable codes; no 422) ─────────────
export const errorCode = z.enum([
  'invalid_request', // 400 — validation failure (incl. limit > 100, Q11)
  'unauthorized', // 401 — missing/bad key or session
  'forbidden', // 403 — same-team scope insufficient
  'not_found', // 404 — missing OR cross-team (anti-enumeration: identical body)
  'duplicate', // 200-companion code, informational
  'idempotency_conflict', // 409 — same key, different payload hash (N1)
  'conflict', // 409 — genuine state conflict
  'payload_too_large', // 413 — request body over 5MB
  'cursor_invalid', // 400 — sort/filter changed or cursor tampered (N3)
  'unsupported_version', // 400 — unknown higher envelope/payload version (N8)
  'version_mismatch', // 400 — CLI/server incompatible (N8)
  'rate_limited', // 429
  'internal', // 500
]);

export const errorResponse = z.strictObject({
  requestId,
  error: z.strictObject({
    code: errorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

// ── Response envelopes (N3) ─────────────────────────────────────────────────
export const listResponse = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    requestId,
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });

export const itemResponse = <T extends z.ZodType>(item: T) =>
  z.strictObject({ requestId, data: item });

// ── Pagination (Q11: default 20, max 100 — over-limit is a 400, no clamping)
export const listLimit = z.coerce.number().int().min(1).max(100).default(20);

// ── Cursor (N3: full structure; untrusted input — server re-validates; ─────
//    NEVER used for authorization. Discriminated per resource so an invalid
//    resource/sort combination cannot be expressed (N8 sort fields.)
const cursorPosition = z.strictObject({
  sortValue: z.string(), // ISO timestamp of the sort field at the boundary row
  id: z.string(), // tie-breaker id of the boundary row
});
const cursorBase = {
  v: z.literal(1),
  projectId,
  position: cursorPosition,
  filterHash: z.string(), // hash of normalized filters — mismatch → cursor_invalid
};

export const cursorPayload = z.discriminatedUnion('resource', [
  z.strictObject({
    resource: z.literal('concepts'),
    sort: z.literal('last_confirmed'), // freshness order (Q10)
    ...cursorBase,
  }),
  z.strictObject({
    resource: z.literal('events'),
    sort: z.literal('created_at'),
    ...cursorBase,
  }),
  z.strictObject({
    resource: z.literal('jobs'),
    sort: z.literal('created_at'),
    ...cursorBase,
  }),
  z.strictObject({
    resource: z.literal('audit'),
    sort: z.literal('created_at'),
    ...cursorBase,
  }),
]);
export type CursorPayload = z.infer<typeof cursorPayload>;

/** Encode a cursor payload as an opaque base64url token. */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode and validate an opaque cursor token. Returns null when the token is
 * malformed or fails schema validation — callers map null to `cursor_invalid`.
 */
export function decodeCursor(token: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    );
    const result = cursorPayload.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
