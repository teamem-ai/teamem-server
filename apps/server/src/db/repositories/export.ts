/**
 * M3 export read repository (DUA-249 / M3-EXPORT-02).
 *
 * Scoped whole-project read for the OKF renderer. The project's compiled
 * knowledge — concepts with their evidence, current + historical paths, and
 * resolved contributors — is assembled into frozen `Concept`-valid pages the
 * renderer can consume directly.
 *
 * Red lines honored:
 * - __Explicit scope (5.5).__ The only entry point takes the tagged
 *   `ScopeContext` from `auth/scope.ts`; `teamId` is always derived from the
 *   scope, never caller-supplied. A project scope fixes the project; an
 *   `allProjects` scope must name one via `options.projectId` (the tagged
 *   union keeps `projectId` off `AllProjectsScope` at compile time). There is
 *   NO unscoped entry accepting bare teamId/projectId strings. The scoped
 *   project existence check returns null for both a missing project and a
 *   project of another team — cross-team is indistinguishable from genuinely
 *   missing (upstream maps null to the same 404).
 * - __Bounded reads.__ Concepts are fetched one page at a time (cursor on
 *   `created_at asc, uuid asc`, limit enforced against a hard cap); each
 *   page's paths/evidence/contributors are fetched in single batched queries
 *   bounded by the page size, never an unbounded project-wide read. A
 *   renderer walks pages via `nextCursor` until null, so memory stays
 *   proportional to one page, not the whole project.
 * - __The return value is renderer-consumable by construction.__ Every
 *   assembled concept is validated against the frozen `concept` Zod schema
 *   before it is returned. A concept that cannot be assembled into a valid
 *   page (e.g. a `concept_paths` row missing — possible via raw SQL) is
 *   never emitted as a fake Concept; it is reported explicitly in `skipped`
 *   with its UUID and the validation reason, so the renderer knows the
 *   export is incomplete and the data-integrity gap is visible.
 * - __Read-only.__ No writes, no side effects; only redacted, persisted data
 *   is read.
 */
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { CONCEPT_SCHEMA_VERSION, concept as conceptSchema } from '@teamem/schema';
import type { Concept, PrincipalRef } from '@teamem/schema';
import type { AppDb } from '../client.js';
import * as schema from '../schema.js';
import {
  isProjectScope,
  type ScopeContext,
} from '../../auth/scope.js';
import { toEvidenceDto, toPrincipalRef } from './concepts-read.js';

// ── Limits (large-project safety) ───────────────────────────────────────────

/** Default page size when the caller does not ask for a specific one. */
export const EXPORT_PAGE_DEFAULT_LIMIT = 500;
/** Hard upper bound — a larger `limit` is rejected, never silently clamped. */
export const EXPORT_PAGE_MAX_LIMIT = 1000;

// ── Return types ────────────────────────────────────────────────────────────

/**
 * One page of the project export. `concepts` contains ONLY concepts that
 * pass the frozen `concept` schema; anything that cannot be assembled is in
 * `skipped` — never disguised as a valid page. Walk `nextCursor` until it is
 * null to drain the whole project.
 */
export interface ProjectExportPage {
  readonly project: { readonly id: string; readonly name: string };
  /** OKF concept format version (N8) — how to interpret every Concept page. */
  readonly schemaVersion: number;
  /** Total number of concepts in the project (across all pages). */
  readonly totalConcepts: number;
  /** Fully assembled, schema-valid concepts for this page. */
  readonly concepts: Concept[];
  /** Concepts that could not be assembled into a valid page, with reasons. */
  readonly skipped: readonly SkippedConcept[];
  /** Opaque cursor for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

export interface SkippedConcept {
  readonly uuid: string;
  readonly reason: string;
}

export interface ExportProjectOptions {
  /**
   * Project to export. Required when `scope.kind === 'allProjects'`; must be
   * omitted (or identical) when the scope is already project-scoped.
   */
  readonly projectId?: string;
  /** Page size; must be >= 1 and <= EXPORT_PAGE_MAX_LIMIT. */
  readonly limit?: number;
  /** Opaque cursor returned by a previous page (must belong to this project). */
  readonly cursor?: string;
}

/** Thrown when a cursor is malformed, tampered, or belongs to another project. */
export class ExportCursorInvalidError extends Error {
  readonly name = 'ExportCursorInvalidError';
}

/** Thrown when `limit` violates the page-size contract (never silently clamped). */
export class ExportLimitInvalidError extends Error {
  readonly name = 'ExportLimitInvalidError';
}

/** Thrown when the scope/project combination is invalid (programming error). */
export class ExportScopeInvalidError extends Error {
  readonly name = 'ExportScopeInvalidError';
}

// ── Cursor (repository-local — deliberately NOT a frozen @teamem/schema DTO) ─

const CURSOR_RESOURCE = 'export-project' as const;
const CURSOR_VERSION = 1 as const;

interface CursorPosition {
  readonly createdAt: string; // ISO timestamp of the boundary concept
  readonly uuid: string; // tie-breaker UUID of the boundary concept
}

function encodePageCursor(projectId: string, position: CursorPosition): string {
  return Buffer.from(
    JSON.stringify({
      resource: CURSOR_RESOURCE,
      v: CURSOR_VERSION,
      projectId,
      position,
    }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode + validate a page cursor. Returns null for malformed / tampered
 * cursors and for cursors not issued for `projectId` (cross-project cursors
 * are rejected, never silently re-interpreted).
 */
function decodePageCursor(token: string, projectId: string): CursorPosition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p['resource'] !== CURSOR_RESOURCE || p['v'] !== CURSOR_VERSION) return null;
  if (p['projectId'] !== projectId) return null;
  const pos = p['position'];
  if (typeof pos !== 'object' || pos === null) return null;
  const position = pos as Record<string, unknown>;
  if (typeof position['createdAt'] !== 'string' || typeof position['uuid'] !== 'string') {
    return null;
  }
  if (Number.isNaN(Date.parse(position['createdAt']))) return null;
  return { createdAt: position['createdAt'], uuid: position['uuid'] };
}

// ── Assembler + frozen-schema gate ──────────────────────────────────────────

type ConceptRow = typeof schema.concepts.$inferSelect;
type EvidenceRow = typeof schema.conceptEvidence.$inferSelect;
type PathRow = typeof schema.conceptPaths.$inferSelect;

/** Shape selected for contributor rows (same join as list/detail reads). */
interface ContributorSelectRow {
  conceptUuid: string;
  id: string;
  kind: 'human' | 'service';
  provider: string;
  providerKind: string;
  displayLogin: string | null;
  userId: string | null;
}

/**
 * Assemble one Concept from its row and its already-fetched children, then
 * require it to satisfy the frozen `concept` schema. Returns `{ kind: 'ok',
 * concept }` or `{ kind: 'skipped', reason }` — never an invalid page.
 *
 * The no-current-path counterexample (a `concept_paths` row deleted via raw
 * SQL) yields `path: ''`, which fails the frozen `conceptPath` syntax and is
 * reported as skipped instead of being returned as a fake Concept.
 */
function assembleValidated(
  row: ConceptRow,
  pathRows: PathRow[],
  evidenceRows: EvidenceRow[],
  contributorRefs: PrincipalRef[],
): { kind: 'ok'; concept: Concept } | { kind: 'skipped'; reason: string } {
  const currentPath = pathRows.find((p) => p.isCurrent)?.path ?? '';
  const aliases = pathRows.filter((p) => !p.isCurrent).map((p) => p.path);

  const assembled: Concept = {
    uuid: row.uuid,
    path: currentPath,
    type: row.type,
    status: row.status,
    confidence: row.confidence,
    title: row.title,
    tags: row.tags,
    lastConfirmed: row.lastConfirmed.toISOString(),
    schemaVersion: CONCEPT_SCHEMA_VERSION,
    firstSeen: row.firstSeen.toISOString(),
    evidenceCount: evidenceRows.length,
    contributors: contributorRefs,
    evidence: evidenceRows.map(toEvidenceDto),
    supersedes: row.supersedesUuid ?? null,
    aliases,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };

  const parsed = conceptSchema.safeParse(assembled);
  if (parsed.success) {
    return { kind: 'ok', concept: parsed.data };
  }

  const first = parsed.error.issues[0];
  const at = first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'fails frozen concept schema';
  return { kind: 'skipped', reason: `cannot be rendered as a valid Concept page — ${at}` };
}

// ── Public API (the ONLY entry point; scoped by ProjectScope) ───────────────

/**
 * Fetch one page of the project's assembled knowledge.
 *
 * Scope (red line 5.5): `teamId` is ALWAYS derived from the passed
 * `ScopeContext` — never caller-supplied. A project-scoped scope fixes the
 * project; an `allProjects` scope requires `options.projectId` (the tagged
 * union keeps `projectId` off `AllProjectsScope` at compile time, so the
 * explicit option is the ONLY way a team-wide scope names a project).
 * Providing a `projectId` that conflicts with a project-scoped scope is a
 * programming error and throws {@link ExportScopeInvalidError}.
 *
 * Returns `null` when the project does not exist OR does not belong to the
 * scope's team — upstream must respond identically for both
 * (anti-enumeration: cross-team is indistinguishable from genuinely missing).
 * Throws {@link ExportCursorInvalidError} for a malformed / tampered /
 * cross-project cursor.
 */
export async function exportProject(
  db: AppDb,
  scope: ScopeContext,
  options: ExportProjectOptions = {},
): Promise<ProjectExportPage | null> {
  const teamId = scope.teamId;

  let projectId: string;
  if (isProjectScope(scope)) {
    if (options.projectId !== undefined && options.projectId !== scope.projectId) {
      throw new ExportScopeInvalidError(
        'projectId does not match the project scope — use an allProjects scope to name a different project',
      );
    }
    projectId = scope.projectId;
  } else {
    if (options.projectId === undefined) {
      throw new ExportScopeInvalidError(
        'projectId is required when the scope is team-wide (allProjects)',
      );
    }
    projectId = options.projectId;
  }

  const limit = clampLimit(options.limit);

  // 1. Scoped project existence check — the anti-enumeration gate.
  const projectRows = await db
    .select({ id: schema.projects.id, name: schema.projects.name })
    .from(schema.projects)
    .where(and(eq(schema.projects.teamId, teamId), eq(schema.projects.id, projectId)))
    .limit(1);

  if (projectRows.length === 0) return null;
  const project = projectRows[0]!;

  // 2. Total (for the renderer and tests) — single bounded scalar query.
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.concepts)
    .where(and(eq(schema.concepts.teamId, teamId), eq(schema.concepts.projectId, projectId)));
  const totalConcepts = countRows[0]?.n ?? 0;

  // 3. Decode the cursor (rejects tampered / cross-project tokens).
  let cursor: CursorPosition | null = null;
  if (options.cursor !== undefined) {
    cursor = decodePageCursor(options.cursor, projectId);
    if (cursor === null) {
      throw new ExportCursorInvalidError(
        'cursor is malformed, tampered, or belongs to another project',
      );
    }
  }

  // 4. One bounded page: limit + 1 for hasMore detection.
  const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof gt> | ReturnType<typeof or> | ReturnType<typeof sql>> = [
    eq(schema.concepts.teamId, teamId),
    eq(schema.concepts.projectId, projectId),
  ];
  if (cursor) {
    const cursorDate = new Date(cursor.createdAt);
    conditions.push(
      or(
        gt(schema.concepts.createdAt, cursorDate),
        and(
          eq(schema.concepts.createdAt, cursorDate),
          gt(schema.concepts.uuid, cursor.uuid),
        ),
      )!,
    );
  }

  const conceptRows = await db
    .select()
    .from(schema.concepts)
    .where(and(...conditions) as ReturnType<typeof and>)
    .orderBy(asc(schema.concepts.createdAt), asc(schema.concepts.uuid))
    .limit(limit + 1);

  const hasMore = conceptRows.length > limit;
  if (hasMore) conceptRows.pop();

  // 5. Children for exactly this page's concepts, batched (bounded by page).
  const uuids = conceptRows.map((r) => r.uuid);
  const [pathRows, evidenceRows, contributorRows]: [
    PathRow[],
    EvidenceRow[],
    ContributorSelectRow[],
  ] = uuids.length === 0
    ? [[], [], []]
    : await Promise.all([
        db
          .select()
          .from(schema.conceptPaths)
          .where(
            and(
              eq(schema.conceptPaths.teamId, teamId),
              eq(schema.conceptPaths.projectId, projectId),
              inArray(schema.conceptPaths.conceptUuid, uuids),
            ),
          )
          .orderBy(asc(schema.conceptPaths.createdAt), asc(schema.conceptPaths.id)),
        db
          .select()
          .from(schema.conceptEvidence)
          .where(
            and(
              eq(schema.conceptEvidence.teamId, teamId),
              eq(schema.conceptEvidence.projectId, projectId),
              inArray(schema.conceptEvidence.conceptUuid, uuids),
            ),
          )
          .orderBy(asc(schema.conceptEvidence.createdAt), asc(schema.conceptEvidence.id)),
        fetchContributors(db, teamId, projectId, uuids),
      ]);

  // 6. Group children by concept UUID and assemble with the frozen-schema gate.
  const pathsByUuid = groupBy(pathRows, (p) => p.conceptUuid);
  const evidenceByUuid = groupBy(evidenceRows, (e) => e.conceptUuid);
  const contributorsByUuid = new Map<string, PrincipalRef[]>();
  for (const [uuid, rows] of groupBy(contributorRows, (c) => c.conceptUuid)) {
    contributorsByUuid.set(
      uuid,
      rows.map((r) =>
        toPrincipalRef({
          id: r.id,
          kind: r.kind,
          provider: r.provider,
          providerKind: r.providerKind,
          displayLogin: r.displayLogin,
          userId: r.userId,
        }),
      ),
    );
  }

  const concepts: Concept[] = [];
  const skipped: SkippedConcept[] = [];
  for (const row of conceptRows) {
    const result = assembleValidated(
      row,
      pathsByUuid.get(row.uuid) ?? [],
      evidenceByUuid.get(row.uuid) ?? [],
      contributorsByUuid.get(row.uuid) ?? [],
    );
    if (result.kind === 'ok') concepts.push(result.concept);
    else skipped.push({ uuid: row.uuid, reason: result.reason });
  }

  // 7. Next cursor — from the last visible row only when a further page exists.
  const last = conceptRows[conceptRows.length - 1];
  const nextCursor = hasMore && last
    ? encodePageCursor(projectId, {
        createdAt: last.createdAt.toISOString(),
        uuid: last.uuid,
      })
    : null;

  return {
    project: { id: projectId, name: project.name },
    schemaVersion: CONCEPT_SCHEMA_VERSION,
    totalConcepts,
    concepts,
    skipped,
    nextCursor,
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Enforce the page-size contract: default, and reject (never clamp) > max. */
function clampLimit(limit: number | undefined): number {
  const requested = limit ?? EXPORT_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(requested) || requested < 1 || requested > EXPORT_PAGE_MAX_LIMIT) {
    throw new ExportLimitInvalidError(
      `limit must be an integer between 1 and ${EXPORT_PAGE_MAX_LIMIT}`,
    );
  }
  return requested;
}

/**
 * Contributors for exactly this page's concepts in one query — same
 * tenant-consistent joins as the concept list/detail reads: principals
 * (scoped to the team), users by github_id = provider_user_id, memberships
 * restricted to the team so `userId` is only resolved when the user is
 * actually a member.
 */
async function fetchContributors(
  db: AppDb,
  teamId: string,
  projectId: string,
  conceptUuids: string[],
): Promise<ContributorSelectRow[]> {
  if (conceptUuids.length === 0) return [];
  return db
    .select({
      conceptUuid: schema.conceptContributors.conceptUuid,
      id: schema.principals.id,
      kind: schema.principals.kind,
      provider: schema.principals.provider,
      providerKind: schema.principals.providerKind,
      displayLogin: schema.principals.displayLogin,
      userId: schema.memberships.userId,
    })
    .from(schema.conceptContributors)
    .innerJoin(
      schema.principals,
      and(
        eq(schema.principals.teamId, teamId),
        eq(schema.principals.id, schema.conceptContributors.principalId),
      ),
    )
    .leftJoin(
      schema.users,
      and(eq(sql`${schema.users.githubId}::text`, schema.principals.providerUserId)),
    )
    .leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.userId, schema.users.id),
        eq(schema.memberships.teamId, teamId),
      ),
    )
    .where(
      and(
        eq(schema.conceptContributors.teamId, teamId),
        eq(schema.conceptContributors.projectId, projectId),
      ),
    )
    .orderBy(asc(schema.conceptContributors.conceptUuid), asc(schema.conceptContributors.principalId));
}

/** Group rows by a key, preserving per-key encounter order. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k) ?? [];
    list.push(row);
    map.set(k, list);
  }
  return map;
}