/**
 * Audit DTOs. (Contract v0.2 Appendix A — N7.)
 *
 * The schema IS the field whitelist: strict objects, nothing beyond these
 * fields is ever stored or returned — no request bodies, no query text, no
 * payload content (search audits record the action and hit resource ids only).
 */
import { z } from 'zod';
import {
  auditId,
  credentialId,
  isoDateTime,
  listLimit,
  listResponse,
  principalId,
  projectId,
  requestId,
  teamId,
} from './common.js';

/**
 * Action vocabulary is an OPEN registry (deliberate, resolving the earlier
 * open-vs-closed contradiction): the wire type is `string`, so consumers on
 * older schema versions never reject audit rows written by a newer server.
 * The server only ever WRITES actions from KNOWN_AUDIT_ACTIONS; consumers
 * MUST tolerate unknown action strings (render as-is). Renaming or removing
 * a known action is a contract version change; appending is not.
 *
 * Tiered auditing (N7): these actions are recorded per call; plain lists and
 * health checks are not. Reads of the audit log are recorded once per query —
 * records produced by reading audit are not re-audited (one level).
 */
export const KNOWN_AUDIT_ACTIONS = [
  'event.ingest',
  'event.payload_read', // fail closed: audit write failure denies the read (N7)
  'concept.read',
  'search.query',
  'context.read',
  'compilation.request',
  'audit.query', // fail closed as well (sensitive read)
  'project.purge', // audit survives purge — purge writes its own entry (N7)
  'key.create',
  'key.revoke',
] as const;
export const auditAction = z.string().min(1);
export type KnownAuditAction = (typeof KNOWN_AUDIT_ACTIONS)[number];

export const auditItem = z.strictObject({
  id: auditId,
  createdAt: isoDateTime,
  requestId,
  principalId: principalId.nullable(),
  credentialId: credentialId.nullable(),
  action: auditAction,
  resourceType: z.enum(['concept', 'event', 'job', 'audit', 'project', 'key']),
  resourceId: z.string().nullable(), // may dangle after purge — historical record
  teamId,
  projectId: projectId.nullable(),
  outcome: z.enum(['success', 'denied', 'failed']),
});
export type AuditItem = z.infer<typeof auditItem>;

export const auditListResponse = listResponse(auditItem);

/** Query params for GET /v1/audit. Sort: created_at desc (N8). */
export const auditListQuery = z.strictObject({
  projectId: projectId.optional(),
  actor: principalId.optional(),
  action: auditAction.optional(),
  cursor: z.string().optional(),
  limit: listLimit,
});
