/**
 * Concept page read repository (M0-READ-04).
 *
 * Provides scoped detail lookups — every query carries both team_id and
 * project_id (red line 5.5). Never fetches first and authorizes later.
 *
 * Two resolution paths:
 * - By canonical UUID (the immutable identity — N5)
 * - By path (current or historical alias — looks up through concept_paths)
 *
 * Returns the full Concept DTO assembled from concepts + concept_paths +
 * concept_evidence + concept_contributors, or null when the resource does
 * not exist or belongs to a different tenant/project.
 */
import { and, eq } from 'drizzle-orm';
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

// ── Public API ──────────────────────────────────────────────────────────────

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
