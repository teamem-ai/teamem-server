/**
 * teamem portal — Drizzle schema, generated from Contract v0.2 (FROZEN
 * 2026-07-17). DTO-level norms live in @teamem/schema (Appendix A); this
 * file is their storage projection. Every decision is annotated (Q/N).
 *
 * Tenancy integrity (N6, hardened after acceptance review): tenant-owned
 * tables carry team_id (and project_id where meaningful) AND are bound by
 * composite foreign keys — projects(team_id, id), concepts/jobs/events
 * (team_id, project_id, pk) — so a row can never reference a project of
 * another team or a parent of another tenant. The redundant columns are
 * therefore integrity-bearing, not mere filter conveniences, and RLS in the
 * SaaS deployment can trust them.
 *
 * Red lines: concept pages are first-class columns, never a flat content
 * TEXT. Evidence is a first-class table (queryable for F4 staleness
 * detection in V1.5 without a migration). All concept paths — current and
 * historical — live in ONE namespace table (concept_paths) so by-path
 * resolution is unique by construction (N5).
 *
 * Migration precondition: `CREATE EXTENSION IF NOT EXISTS vector` is
 * included at the top of the initial migration (also covered by the compose
 * initdb script for fresh volumes).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// ── Enums (Q1 note: pgEnum chosen over text+CHECK — ALTER TYPE ADD VALUE is
//    the cheap migration path for additive changes) ─────────────────────────
export const principalKind = pgEnum('principal_kind', ['human', 'service']);
export const identityProvider = pgEnum('identity_provider', ['github']);
export const sourceChannel = pgEnum('source_channel', ['github', 'cli', 'mcp']);
export const sourceKind = pgEnum('source_kind', [
  'github_commit',
  'github_pr',
  'github_issue',
  'github_pr_comment',
  'cli_init',
  'mcp_write',
]);
export const actorProvenance = pgEnum('actor_provenance', [
  'webhook_verified',
  'credential_bound',
  'client_claimed',
  'unknown',
]);
export const occurredAtProvenance = pgEnum('occurred_at_provenance', [
  'provider',
  'client',
  'server',
]);
export const conceptType = pgEnum('concept_type', [
  'service',
  'concept',
  'decision',
  'gotcha',
  'convention',
  'runbook',
]);
export const conceptStatus = pgEnum('concept_status', [
  'active',
  'superseded',
  'disputed',
  'needs-review',
]);
export const confidence = pgEnum('confidence', ['high', 'medium', 'low']);
export const evidenceKind = pgEnum('evidence_kind', [
  'commit',
  'pr',
  'issue',
  'pr_comment',
  'repo_file',
  'mcp_write',
  'manual',
]);
export const jobStatus = pgEnum('job_status', [
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
]);
// N1 (hardened after acceptance review): idempotency identity includes the
// operation kind — a batch and a compilation sharing a key must not collide.
export const jobKind = pgEnum('job_kind', [
  'ingest_event',
  'ingest_batch',
  'compilation',
]);
export const jobEventStatus = pgEnum('job_event_status', [
  'pending',
  'compiled',
  'skipped',
  'failed',
]);
export const initiatorKind = pgEnum('initiator_kind', [
  'credential',
  'connector',
]);
export const auditResourceType = pgEnum('audit_resource_type', [
  'concept',
  'event',
  'job',
  'audit',
  'project',
  'key',
]);
export const auditOutcome = pgEnum('audit_outcome', [
  'success',
  'denied',
  'failed',
]);

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow();
const ts = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3 });

// ── Tenancy ─────────────────────────────────────────────────────────────────
export const teams = pgTable('teams', {
  id: text('id').primaryKey(), // team_...
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(), // prj_...
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('projects_team_idx').on(t.teamId),
    // Composite-FK target: lets children bind (team_id, project_id) as one
    // unit so a project of another team can never be referenced.
    unique('projects_team_id_uq').on(t.teamId, t.id),
  ],
);

// ── Identity (Q5/N2) ────────────────────────────────────────────────────────
export const principals = pgTable(
  'principals',
  {
    id: text('id').primaryKey(), // pri_...
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    kind: principalKind('kind').notNull(),
    provider: identityProvider('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(), // stable numeric id
    displayLogin: text('display_login'), // mutable, display only
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('principals_identity_uq').on(
      t.teamId,
      t.provider,
      t.providerUserId,
    ),
    // Composite-FK target for tenant-consistent attribution.
    unique('principals_team_id_uq').on(t.teamId, t.id),
  ],
);

// ── API keys (N6/N7) ────────────────────────────────────────────────────────
export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(), // key_...
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    projectId: text('project_id'),
    principalId: text('principal_id'),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(), // SHA-256; plaintext shown once at mint
    scopes: text('scopes').array().notNull(),
    allProjects: boolean('all_projects').notNull().default(false),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [
    index('api_keys_team_idx').on(t.teamId),
    foreignKey({
      name: 'api_keys_project_fk',
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }),
    foreignKey({
      name: 'api_keys_principal_fk',
      columns: [t.teamId, t.principalId],
      foreignColumns: [principals.teamId, principals.id],
    }),
    // N6 least privilege as a database invariant, not a comment: normal keys
    // bind a project; team-wide keys are explicit.
    check(
      'api_keys_least_privilege_ck',
      sql`(${t.allProjects} = true AND ${t.projectId} IS NULL) OR (${t.allProjects} = false AND ${t.projectId} IS NOT NULL)`,
    ),
    // N7 mint-time superset rule: read:payload requires read.
    check(
      'api_keys_scope_superset_ck',
      sql`NOT ('read:payload' = ANY(${t.scopes})) OR ('read' = ANY(${t.scopes}))`,
    ),
  ],
);

// ── Events (contract ② / N1/N2/N8) ─────────────────────────────────────────
export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(), // evt_...
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    projectId: text('project_id').notNull(),
    channel: sourceChannel('channel').notNull(), // raw channel fact (N1)
    kind: sourceKind('kind').notNull(), // parse result — NOT part of idempotency
    sourceEvent: text('source_event'), // raw provider event name (Q6)
    sourceAction: text('source_action'), // raw provider action (Q6)
    deliveryId: text('delivery_id').notNull(),
    itemKey: text('item_key').notNull(), // sub-item id; 'root' when unsplit
    externalId: text('external_id').notNull(),
    url: text('url'),
    actor: jsonb('actor'), // raw claim, preserved verbatim (general rule)
    actorProvenance: actorProvenance('actor_provenance').notNull(),
    actorPrincipalId: text('actor_principal_id'),
    occurredAt: ts('occurred_at').notNull(),
    occurredAtProvenance: occurredAtProvenance(
      'occurred_at_provenance',
    ).notNull(), // separate from actor trust (N8)
    ingestedByCredentialId: text('ingested_by_credential_id'), // null for internal connectors
    ingestedByPrincipalId: text('ingested_by_principal_id'),
    payload: jsonb('payload').notNull(), // POST-strip content — no pre-strip version exists (N7)
    payloadBytes: integer('payload_bytes').notNull(),
    payloadHash: text('payload_hash').notNull(), // sha256(canonical_json(stripped)) (N1)
    payloadSchemaVersion: integer('payload_schema_version').notNull(),
    envelopeVersion: integer('envelope_version').notNull(),
    createdAt: createdAt(), // server time — sorting/cursor/audit (N8)
  },
  (t) => [
    foreignKey({
      name: 'events_project_fk',
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }),
    foreignKey({
      name: 'events_actor_principal_fk',
      columns: [t.teamId, t.actorPrincipalId],
      foreignColumns: [principals.teamId, principals.id],
    }),
    // N1: four-element idempotent identity on raw source facts.
    uniqueIndex('events_idempotency_uq').on(
      t.projectId,
      t.channel,
      t.deliveryId,
      t.itemKey,
    ),
    // Composite-FK target for job_events tenant consistency.
    unique('events_tenant_uq').on(t.teamId, t.projectId, t.id),
    index('events_cursor_idx').on(t.projectId, t.createdAt, t.id),
    index('events_team_idx').on(t.teamId),
  ],
);

// ── Concepts (contract ① / N5: uuid canonical; the current path lives in ───
//    concept_paths — ONE namespace for current + historical paths) ──────────
export const concepts = pgTable(
  'concepts',
  {
    uuid: uuid('uuid').primaryKey().defaultRandom(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    projectId: text('project_id').notNull(),
    schemaVersion: integer('schema_version').notNull(), // OKF format version (N8)
    type: conceptType('type').notNull(),
    status: conceptStatus('status').notNull(),
    confidence: confidence('confidence').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(), // markdown; links: teamem://concept/<uuid>
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    firstSeen: ts('first_seen').notNull(),
    lastConfirmed: ts('last_confirmed').notNull(), // corroboration-only updates (Q10)
    supersedesUuid: uuid('supersedes_uuid'), // self-reference; loser retained
    // Embedding: text-embedding-3-small / 1536 dims (M0 column, M1 values).
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'concepts_project_fk',
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }),
    // Composite-FK target for child tables (evidence/contributors/paths).
    unique('concepts_tenant_uq').on(t.teamId, t.projectId, t.uuid),
    // Freshness order (Q10) — the concepts cursor index.
    index('concepts_cursor_idx').on(t.projectId, t.lastConfirmed, t.uuid),
    index('concepts_tags_gin').using('gin', t.tags),
    index('concepts_embedding_hnsw').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    index('concepts_team_idx').on(t.teamId),
  ],
);

// ── Concept paths (N5, hardened after acceptance review): current path and
//    historical aliases share ONE unique namespace — by-path resolution is
//    unique by construction; two independent indexes cannot guarantee that.
export const conceptPaths = pgTable(
  'concept_paths',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    projectId: text('project_id').notNull(),
    conceptUuid: uuid('concept_uuid').notNull(),
    path: text('path').notNull(), // frozen syntax, stored lowercase (N5)
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'concept_paths_concept_fk',
      columns: [t.teamId, t.projectId, t.conceptUuid],
      foreignColumns: [concepts.teamId, concepts.projectId, concepts.uuid],
    }),
    // THE namespace guarantee: one path resolves to exactly one concept.
    uniqueIndex('concept_paths_namespace_uq').on(t.projectId, t.path),
    // At most one current path per concept (app ensures at-least-one in the
    // same transaction that creates/renames a concept).
    uniqueIndex('concept_paths_current_uq')
      .on(t.conceptUuid)
      .where(sql`${t.isCurrent} = true`),
  ],
);

// ── Evidence (Q2: first-class rows; repo_file carries immutable refs) ──────
export const conceptEvidence = pgTable(
  'concept_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    projectId: text('project_id').notNull(),
    conceptUuid: uuid('concept_uuid').notNull(),
    kind: evidenceKind('kind').notNull(),
    ref: text('ref'), // url kinds + mcp_write/manual
    repo: text('repo'), // repo_file
    commitSha: text('commit_sha'), // repo_file — immutable anchor (Q2)
    path: text('path'), // repo_file — queryable for F4 (V1.5)
    at: ts('at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'concept_evidence_concept_fk',
      columns: [t.teamId, t.projectId, t.conceptUuid],
      foreignColumns: [concepts.teamId, concepts.projectId, concepts.uuid],
    }),
    index('concept_evidence_concept_idx').on(t.conceptUuid),
    index('concept_evidence_path_idx').on(t.projectId, t.repo, t.path),
  ],
);

// ── Contributors (Q5: principal ids only; client_claimed never lands here) ─
export const conceptContributors = pgTable(
  'concept_contributors',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    projectId: text('project_id').notNull(),
    conceptUuid: uuid('concept_uuid').notNull(),
    principalId: text('principal_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conceptUuid, t.principalId] }),
    foreignKey({
      name: 'concept_contributors_concept_fk',
      columns: [t.teamId, t.projectId, t.conceptUuid],
      foreignColumns: [concepts.teamId, concepts.projectId, concepts.uuid],
    }),
    // Tenant-consistent attribution: the principal belongs to the same team.
    foreignKey({
      name: 'concept_contributors_principal_fk',
      columns: [t.teamId, t.principalId],
      foreignColumns: [principals.teamId, principals.id],
    }),
    // Q9: contributor filter on the concepts list.
    index('concept_contributors_filter_idx').on(t.projectId, t.principalId),
  ],
);

// ── Jobs (N1/N3/N4/N6) ──────────────────────────────────────────────────────
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    projectId: text('project_id').notNull(),
    kind: jobKind('kind').notNull(), // idempotency scoping + replay semantics (N1)
    status: jobStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    initiatedByKind: initiatorKind('initiated_by_kind').notNull(), // N6
    initiatedByCredentialId: text('initiated_by_credential_id'),
    initiatedByPrincipalId: text('initiated_by_principal_id'),
    initiatedByConnector: text('initiated_by_connector'), // 'github'
    idempotencyKey: text('idempotency_key'), // batch & compilations (N1)
    // N1 replay semantics: same key + same hash → return original; same key +
    // different hash → 409 idempotency_conflict. Hash of the canonical request.
    idempotencyRequestHash: text('idempotency_request_hash'),
    // Per-item intake results snapshot (incl. rejected items that never became
    // event rows) so an idempotent replay returns the ORIGINAL batch response.
    resultSnapshot: jsonb('result_snapshot'),
    eventCount: integer('event_count').notNull(),
    error: jsonb('error'), // sanitized {code,message} — never payload/prompt/provider (N3)
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    foreignKey({
      name: 'jobs_project_fk',
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }),
    // Idempotency identity includes the operation kind: a batch and a
    // compilation may legally share a key without colliding.
    uniqueIndex('jobs_idempotency_uq')
      .on(t.projectId, t.kind, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    // Composite-FK target for job_events tenant consistency.
    unique('jobs_tenant_uq').on(t.teamId, t.projectId, t.id),
    index('jobs_cursor_idx').on(t.projectId, t.createdAt, t.id),
    index('jobs_status_idx').on(t.projectId, t.status),
  ],
);

// ── Per-event job outcomes (N4 discriminated results) ───────────────────────
export const jobEvents = pgTable(
  'job_events',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    projectId: text('project_id').notNull(),
    jobId: uuid('job_id').notNull(),
    eventId: text('event_id').notNull(),
    status: jobEventStatus('status').notNull().default('pending'),
    reason: text('reason'), // skipped: no_knowledge | already_compiled (open registry)
    error: jsonb('error'), // failed: sanitized {code,message}
    conceptUuids: uuid('concept_uuids').array(), // compiled: pages touched
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.eventId] }),
    // Tenant consistency with BOTH parents: job and event must belong to the
    // same (team, project) as this row.
    foreignKey({
      name: 'job_events_job_fk',
      columns: [t.teamId, t.projectId, t.jobId],
      foreignColumns: [jobs.teamId, jobs.projectId, jobs.id],
    }),
    foreignKey({
      name: 'job_events_event_fk',
      columns: [t.teamId, t.projectId, t.eventId],
      foreignColumns: [events.teamId, events.projectId, events.id],
    }),
  ],
);

// ── Audit (N7: the columns ARE the whitelist; append-safe by design — ──────
//    deliberately NO foreign keys on THIS table only: rows survive purge,
//    ids may dangle, and an audit write must never fail on referential
//    grounds. All other tables are fully FK-constrained.) ───────────────────
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: createdAt(),
    requestId: text('request_id').notNull(),
    principalId: text('principal_id'), // no FK — historical record
    credentialId: text('credential_id'), // no FK
    action: text('action').notNull(), // OPEN registry — deliberately not an enum (N7)
    resourceType: auditResourceType('resource_type').notNull(),
    resourceId: text('resource_id'), // may dangle after purge (N7)
    teamId: text('team_id').notNull(), // no FK — survives team deletion
    projectId: text('project_id'), // no FK — survives purge
    outcome: auditOutcome('outcome').notNull(),
  },
  (t) => [
    index('audit_team_cursor_idx').on(t.teamId, t.createdAt, t.id),
    index('audit_project_cursor_idx').on(t.projectId, t.createdAt, t.id),
  ],
);
