/**
 * Concept page DTOs. (Contract v0.2 Appendix A — contract ① + Q1-Q5/Q10/N5/N8.)
 */
import { z } from 'zod';
import {
  conceptUuid,
  isoDateTime,
  itemResponse,
  listLimit,
  listResponse,
  principalId,
  projectId,
  CONCEPT_SCHEMA_VERSION,
} from './common.js';

// ── Enumerations (Q1/Q3 — definitions & admission rules live in the F1 prompt
//    spec; these are the frozen value sets) ─────────────────────────────────
export const conceptType = z.enum([
  'service',
  'concept',
  'decision',
  'gotcha',
  'convention',
  'runbook',
]);
export type ConceptType = z.infer<typeof conceptType>;

export const conceptStatus = z.enum([
  'active',
  'superseded',
  'disputed', // contradicting evidence → status change, never a confidence cut (Q3)
  'needs-review',
]);
export const confidence = z.enum(['high', 'medium', 'low']);

// ── Path (N5: readable/export locator — renameable, alias-preserving; ──────
//    uuid is the canonical identity. Syntax frozen for export safety.) ──────
export const conceptPath = z
  .string()
  .max(200)
  .regex(
    /^[a-z0-9-]+(\/[a-z0-9-]+)*$/,
    'lowercase segments [a-z0-9-] joined by "/" — no leading slash, no dots, no empty segments',
  );

/** In-body link target: `teamem://concept/<uuid>` (N5). Export resolves uuid → current path → relative markdown link. */
export const conceptLinkPattern =
  /^teamem:\/\/concept\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function conceptLink(uuid: string): string {
  return `teamem://concept/${uuid}`;
}

// ── Evidence (Q2: repo_file requires an immutable reference — a bare path ──
//    drifts with branches and is insufficient as historical evidence) ────────
// Explicit members — the union is contract text, spelled out per kind.
export const evidence = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('commit'), ref: z.url(), at: isoDateTime }),
  z.strictObject({ kind: z.literal('pr'), ref: z.url(), at: isoDateTime }),
  z.strictObject({ kind: z.literal('issue'), ref: z.url(), at: isoDateTime }),
  z.strictObject({
    kind: z.literal('pr_comment'),
    ref: z.url(),
    at: isoDateTime,
  }),
  z.strictObject({
    kind: z.literal('repo_file'), // Q2: immutable reference required —
    repo: z.string().min(1), // a bare path drifts with branches
    commitSha: z.string().regex(/^[0-9a-f]{7,40}$/),
    path: z.string().min(1),
    at: isoDateTime,
  }),
  z.strictObject({
    kind: z.literal('mcp_write'),
    ref: z.string().min(1), // event id or other stable internal reference
    at: isoDateTime,
  }),
  z.strictObject({
    kind: z.literal('manual'),
    ref: z.string().min(1),
    at: isoDateTime,
  }),
]);
export type Evidence = z.infer<typeof evidence>;

// ── Concept DTOs ────────────────────────────────────────────────────────────
/** List item — summary shape served by GET /v1/concepts (N7: lists are summaries). */
export const conceptSummary = z.strictObject({
  uuid: conceptUuid,
  path: conceptPath,
  type: conceptType,
  status: conceptStatus,
  confidence,
  title: z.string().min(1),
  tags: z.array(z.string()),
  lastConfirmed: isoDateTime, // updated only on corroboration or human confirm (Q10)
});
export type ConceptSummary = z.infer<typeof conceptSummary>;

/** Full detail served by GET /v1/concepts/:uuid. */
export const concept = conceptSummary.extend({
  schemaVersion: z.literal(CONCEPT_SCHEMA_VERSION), // N8: OKF format version
  firstSeen: isoDateTime,
  contributors: z.array(principalId), // stable principal ids (Q5) — client_claimed actors excluded (N2)
  evidence: z.array(evidence).min(1), // red line: every page carries evidence
  supersedes: conceptUuid.nullable(), // decision archaeology — loser retained
  aliases: z.array(conceptPath), // previous paths after renames (N5)
  body: z.string(), // markdown; internal links use teamem://concept/<uuid>
  createdAt: isoDateTime,
});
export type Concept = z.infer<typeof concept>;

/** Query params for GET /v1/concepts (Q9/Q10/Q11). Default sort: last_confirmed desc. */
export const conceptListQuery = z.strictObject({
  projectId,
  type: conceptType.optional(),
  status: conceptStatus.optional(),
  tag: z.string().optional(),
  contributor: principalId.optional(),
  cursor: z.string().optional(),
  limit: listLimit,
});

// ── Named endpoint response DTOs (N3) ───────────────────────────────────────
export const conceptListResponse = listResponse(conceptSummary);
export const conceptDetailResponse = itemResponse(concept);
