/**
 * Project Purge Repository (DUA-228).
 *
 * Deletes all project-scoped data (events, concepts, jobs, and related
 * child rows) within a single database transaction. Explicitly preserves
 * audit records and principals by design (N7): the audit_log table has no
 * FK constraints precisely so rows survive purge.
 *
 * Design invariants:
 * - Every DELETE is scoped by both team_id AND project_id (red line 5.5).
 * - Deletion order respects FK constraints: child tables first,
 *   then the parent tables.
 * - The entire operation runs in a single transaction: partial failure
 *   rolls back, leaving the project data intact.
 * - Returns per-table deletion counts so the caller can include them in
 *   the audit record and the response payload.
 *
 * Tables purged (in FK-safe order):
 *   1. concept_contributors  (FK → concepts, FK → principals)
 *   2. concept_evidence      (FK → concepts)
 *   3. concept_paths         (FK → concepts)
 *   4. concepts              (FK → projects)
 *   5. job_events            (FK → jobs, FK → events)
 *   6. jobs                  (FK → projects)
 *   7. events                (FK → projects)
 *
 * Tables NOT purged:
 *   - auditLog   (no FK — survives by design, N7)
 *   - principals (team-scoped identity, survives purge)
 *   - apiKeys    (configuration, not project data)
 *   - teams/projects/users/memberships/invites/webSessions
 */
import { eq, and } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';

// ── Result type ─────────────────────────────────────────────────────────────

/**
 * Per-table deletion counts from a successful purge.
 */
export interface PurgeCounts {
  readonly eventsDeleted: number;
  readonly conceptsDeleted: number;
  readonly conceptPathsDeleted: number;
  readonly conceptEvidenceDeleted: number;
  readonly conceptContributorsDeleted: number;
  readonly jobsDeleted: number;
  readonly jobEventsDeleted: number;
}

// ── Core purge function ────────────────────────────────────────────────────

/**
 * Delete all project-scoped data for a given (teamId, projectId) pair.
 *
 * The entire operation executes inside a single database transaction so
 * partial failure is impossible — either everything is deleted or
 * nothing is (red line 5.5: transactional safety).
 *
 * Deletion order is FK-safe: child tables are deleted before their
 * parents so no FK violation occurs mid-transaction.
 *
 * The caller is responsible for writing the purge audit record AFTER
 * this function returns successfully. The audit write is deliberately
 * outside the purge transaction so the audit row is never inside the
 * DELETE scope (N7: audit survives purge).
 *
 * @param db - The Drizzle database instance
 * @param teamId - Tenant identity (red line 5.5)
 * @param projectId - Project identity
 * @returns Per-table deletion counts
 */
export async function purgeProjectData(
  db: AppDb,
  teamId: string,
  projectId: string,
): Promise<PurgeCounts> {
  return db.transaction(async (tx) => {
    // 1. concept_contributors — child of concepts, FK to principals (principals survive)
    const conceptContributorsResult = await tx
      .delete(schema.conceptContributors)
      .where(
        and(
          eq(schema.conceptContributors.teamId, teamId),
          eq(schema.conceptContributors.projectId, projectId),
        ),
      )
      .returning({ principalId: schema.conceptContributors.principalId });

    // 2. concept_evidence — child of concepts
    const conceptEvidenceResult = await tx
      .delete(schema.conceptEvidence)
      .where(
        and(
          eq(schema.conceptEvidence.teamId, teamId),
          eq(schema.conceptEvidence.projectId, projectId),
        ),
      )
      .returning({ id: schema.conceptEvidence.id });

    // 3. concept_paths — child of concepts
    const conceptPathsResult = await tx
      .delete(schema.conceptPaths)
      .where(
        and(
          eq(schema.conceptPaths.teamId, teamId),
          eq(schema.conceptPaths.projectId, projectId),
        ),
      )
      .returning({ id: schema.conceptPaths.id });

    // 4. concepts — parent table
    const conceptsResult = await tx
      .delete(schema.concepts)
      .where(
        and(
          eq(schema.concepts.teamId, teamId),
          eq(schema.concepts.projectId, projectId),
        ),
      )
      .returning({ uuid: schema.concepts.uuid });

    // 5. job_events — child of both jobs and events
    const jobEventsResult = await tx
      .delete(schema.jobEvents)
      .where(
        and(
          eq(schema.jobEvents.teamId, teamId),
          eq(schema.jobEvents.projectId, projectId),
        ),
      )
      .returning({ eventId: schema.jobEvents.eventId });

    // 6. jobs — parent of job_events
    const jobsResult = await tx
      .delete(schema.jobs)
      .where(
        and(
          eq(schema.jobs.teamId, teamId),
          eq(schema.jobs.projectId, projectId),
        ),
      )
      .returning({ id: schema.jobs.id });

    // 7. events — parent of job_events
    const eventsResult = await tx
      .delete(schema.events)
      .where(
        and(
          eq(schema.events.teamId, teamId),
          eq(schema.events.projectId, projectId),
        ),
      )
      .returning({ id: schema.events.id });

    return {
      eventsDeleted: eventsResult.length,
      conceptsDeleted: conceptsResult.length,
      conceptPathsDeleted: conceptPathsResult.length,
      conceptEvidenceDeleted: conceptEvidenceResult.length,
      conceptContributorsDeleted: conceptContributorsResult.length,
      jobsDeleted: jobsResult.length,
      jobEventsDeleted: jobEventsResult.length,
    };
  });
}
