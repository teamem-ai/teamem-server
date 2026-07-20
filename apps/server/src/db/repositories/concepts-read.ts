/**
 * Concept page read repository (M0-READ-03 + M0-READ-04).
 *
 * Provides:
 * - Scoped detail lookups by UUID or path (M0-READ-04)
 * - Scoped list query with type/status/tag/contributor filtering,
 *   composite cursor pagination, and GIN-based tag filtering (M0-READ-03)
 *
 * Every query carries both team_id and project_id (red line 5.5).
 * Never fetches first and authorizes later.
 */
import { and, eq, lt, gt, or, desc, asc, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Concept, Evidence } from '@teamem/schema';
import { CONCEPT_SCHEMA_VERSION } from '@teamem/schema';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';

// ── Evidence row shape ──────────────────────────────────────────────────────

type EvidenceRow = typeof schema.conceptEvidence.$inferSelect;

/** Map a DB evidence row to the frozen Evidence discriminated union. */
function toEvidenceDto(row: EvidenceRow): Evidence {
  const at = row.at.toISOString();
  switch (row.kind) {
    case 'commit':
    case 'pr':
    case 'issue':
    case 'pr_comment':
      return { kind: row.kind, ref: row.ref ?? '', at };
    case 'repo_file':
      return {
        kind: 'repo_file',
        repo: row.repo ?? '',
        commitSha: row.commitSha ?? '',
        path: row.path ?? '',
        at,
      };
    case 'mcp_write':
    case 'manual':
      return { kind: row.kind, ref: row.ref ?? '', at };
  }
}

// ── Internal assembler ──────────────────────────────────────────────────────

/**
 * Given a concept row, fetch its paths, evidence, and contributors and
 * assemble the full Concept DTO.  All child queries carry team_id +
 * project_id (scoped).
 */
async function assembleConcept(
  db: AppDb,
  teamId: string,
  projectId: string,
  conceptRow: typeof schema.concepts.$inferSelect,
): Promise<Concept> {
  const conceptUuid = conceptRow.uuid;

  // 1. Paths — current + historical aliases (N5: single namespace)
  const pathRows = await db
    .select({
      path: schema.conceptPaths.path,
      isCurrent: schema.conceptPaths.isCurrent,
    })
    .from(schema.conceptPaths)
    .where(
      and(
        eq(schema.conceptPaths.teamId, teamId),
        eq(schema.conceptPaths.projectId, projectId),
        eq(schema.conceptPaths.conceptUuid, conceptUuid),
      ),
    );

  const currentPath = pathRows.find((p) => p.isCurrent)?.path ?? '';
  const aliases = pathRows.filter((p) => !p.isCurrent).map((p) => p.path);

  // 2. Evidence (Q2: first-class rows)
  const evidenceRows = await db
    .select()
    .from(schema.conceptEvidence)
    .where(
      and(
        eq(schema.conceptEvidence.teamId, teamId),
        eq(schema.conceptEvidence.projectId, projectId),
        eq(schema.conceptEvidence.conceptUuid, conceptUuid),
      ),
    );

  // 3. Contributors (Q5: principal ids only)
  const contributorRows = await db
    .select({
      principalId: schema.conceptContributors.principalId,
    })
    .from(schema.conceptContributors)
    .where(
      and(
        eq(schema.conceptContributors.teamId, teamId),
        eq(schema.conceptContributors.projectId, projectId),
        eq(schema.conceptContributors.conceptUuid, conceptUuid),
      ),
    );

  return {
    uuid: conceptUuid,
    path: currentPath,
    type: conceptRow.type,
    status: conceptRow.status,
    confidence: conceptRow.confidence,
    title: conceptRow.title,
    tags: conceptRow.tags,
    lastConfirmed: conceptRow.lastConfirmed.toISOString(),
    schemaVersion: CONCEPT_SCHEMA_VERSION,
    firstSeen: conceptRow.firstSeen.toISOString(),
    contributors: contributorRows.map((r) => r.principalId),
    evidence: evidenceRows.map(toEvidenceDto),
    supersedes: conceptRow.supersedesUuid ?? null,
    aliases,
    body: conceptRow.body,
    createdAt: conceptRow.createdAt.toISOString(),
  };
}

// ── Public API: detail lookups (M0-READ-04) ────────────────────────────────

/**
 * Fetch a concept page by its canonical UUID, scoped to team + project.
 *
 * Returns `null` when the UUID does not exist OR belongs to a different
 * tenant/project — callers must return 404 for both cases (anti-enumeration).
 */
export async function getConceptByUuid(
  db: AppDb,
  teamId: string,
  projectId: string,
  uuid: string,
): Promise<Concept | null> {
  const rows = await db
    .select()
    .from(schema.concepts)
    .where(
      and(
        eq(schema.concepts.teamId, teamId),
        eq(schema.concepts.projectId, projectId),
        eq(schema.concepts.uuid, uuid),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;

  return assembleConcept(db, teamId, projectId, rows[0]!);
}

/**
 * Fetch a concept page by its path (current or historical alias), scoped to
 * team + project.
 *
 * Paths are unique within a project (guaranteed by
 * `concept_paths_namespace_uq`), so at most one concept can match.  Returns
 * `null` when the path does not exist OR belongs to a different
 * tenant/project — callers must return 404 for both cases (anti-enumeration).
 */
export async function getConceptByPath(
  db: AppDb,
  teamId: string,
  projectId: string,
  path: string,
): Promise<Concept | null> {
  // 1. Resolve path → concept UUID (scoped).
  const pathRows = await db
    .select({
      conceptUuid: schema.conceptPaths.conceptUuid,
    })
    .from(schema.conceptPaths)
    .where(
      and(
        eq(schema.conceptPaths.teamId, teamId),
        eq(schema.conceptPaths.projectId, projectId),
        eq(schema.conceptPaths.path, path),
      ),
    )
    .limit(1);

  if (pathRows.length === 0) return null;

  // 2. Delegate to UUID lookup (reuses the scoped concept fetch + assembly).
  return getConceptByUuid(db, teamId, projectId, pathRows[0]!.conceptUuid);
}

// ── Public API: list query (M0-READ-03) ────────────────────────────────────

/** Raw concept row from the list query. */
export interface ConceptRow {
  readonly uuid: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly schemaVersion: number;
  readonly type: string;
  readonly status: string;
  readonly confidence: string;
  readonly title: string;
  readonly body: string;
  readonly tags: string[];
  readonly firstSeen: Date;
  readonly lastConfirmed: Date;
  readonly supersedesUuid: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Current path from concept_paths (null if somehow missing — should never happen). */
  readonly path: string | null;
}

const CONCEPT_WITH_PATH_COLUMNS = {
  uuid: schema.concepts.uuid,
  teamId: schema.concepts.teamId,
  projectId: schema.concepts.projectId,
  schemaVersion: schema.concepts.schemaVersion,
  type: schema.concepts.type,
  status: schema.concepts.status,
  confidence: schema.concepts.confidence,
  title: schema.concepts.title,
  body: schema.concepts.body,
  tags: schema.concepts.tags,
  firstSeen: schema.concepts.firstSeen,
  lastConfirmed: schema.concepts.lastConfirmed,
  supersedesUuid: schema.concepts.supersedesUuid,
  createdAt: schema.concepts.createdAt,
  updatedAt: schema.concepts.updatedAt,
  path: schema.conceptPaths.path,
};

export interface ListConceptsParams {
  readonly teamId: string;
  readonly projectId: string;
  readonly type?: string;
  readonly status?: string;
  readonly tag?: string;
  readonly contributor?: string;
  /** ISO 8601 timestamp of the cursor boundary row's last_confirmed. */
  readonly cursorSortValue?: string;
  /** UUID of the cursor boundary row. */
  readonly cursorId?: string;
  readonly limit: number;
}

export interface ListConceptsResult {
  readonly rows: ConceptRow[];
  readonly hasMore: boolean;
}

/**
 * List concepts scoped to a team + project, with optional filters and
 * composite cursor pagination.
 *
 * Sort order: `last_confirmed DESC, uuid ASC` (frozen by the concepts cursor
 * contract — Q10 freshness order).
 *
 * Filter semantics:
 * - `type` and `status`: exact match on the concept row (simple equality).
 * - `tag`: uses the `concepts_tags_gin` GIN index — `tags @> ARRAY[$tag]`.
 * - `contributor`: subquery on `concept_contributors` using
 *   `concept_contributors_filter_idx` on (project_id, principal_id).
 *
 * Always returns `limit + 1` rows internally for hasMore detection; the
 * extra row is stripped from the result.
 */
export async function listConcepts(
  db: AppDb,
  params: ListConceptsParams,
): Promise<ListConceptsResult> {
  const { teamId, projectId, limit } = params;

  // ── Build WHERE conditions ────────────────────────────────────────────
  const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof lt> | ReturnType<typeof gt> | ReturnType<typeof or> | ReturnType<typeof inArray> | ReturnType<typeof sql>> = [
    eq(schema.concepts.teamId, teamId),
    eq(schema.concepts.projectId, projectId),
  ];

  if (params.type) {
    conditions.push(eq(schema.concepts.type, params.type as typeof schema.concepts.type.enumValues[number]));
  }
  if (params.status) {
    conditions.push(eq(schema.concepts.status, params.status as typeof schema.concepts.status.enumValues[number]));
  }

  // Tag filter — GIN-indexed array containment (concepts_tags_gin).
  if (params.tag) {
    conditions.push(
      sql`${schema.concepts.tags} @> ARRAY[${params.tag}]::text[]`,
    );
  }

  // Contributor filter — subquery (concept_contributors_filter_idx).
  if (params.contributor) {
    conditions.push(
      inArray(
        schema.concepts.uuid,
        db
          .select({ conceptUuid: schema.conceptContributors.conceptUuid })
          .from(schema.conceptContributors)
          .where(
            and(
              eq(schema.conceptContributors.teamId, teamId),
              eq(schema.conceptContributors.projectId, projectId),
              eq(schema.conceptContributors.principalId, params.contributor),
            ),
          ),
      ),
    );
  }

  // Cursor pagination: items AFTER (sortValue, id) in (last_confirmed DESC, uuid ASC).
  if (params.cursorSortValue && params.cursorId) {
    const cursorDate = new Date(params.cursorSortValue);
    conditions.push(
      or(
        lt(schema.concepts.lastConfirmed, cursorDate),
        and(
          eq(schema.concepts.lastConfirmed, cursorDate),
          gt(schema.concepts.uuid, params.cursorId),
        ),
      )!,
    );
  }

  // ── Execute query ─────────────────────────────────────────────────────
  const rows = await db
    .select(CONCEPT_WITH_PATH_COLUMNS)
    .from(schema.concepts)
    .leftJoin(
      schema.conceptPaths,
      and(
        eq(schema.conceptPaths.conceptUuid, schema.concepts.uuid),
        eq(schema.conceptPaths.isCurrent, true),
      ),
    )
    .where(and(...conditions) as ReturnType<typeof and>)
    .orderBy(desc(schema.concepts.lastConfirmed), asc(schema.concepts.uuid))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  if (hasMore) {
    rows.pop();
  }

  return {
    rows: rows as unknown as ConceptRow[],
    hasMore,
  };
}
