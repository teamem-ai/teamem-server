/**
 * Concept page write repository.
 *
 * Creates a concept page, its current path, evidence, and trusted contributors
 * in a single database transaction. Enforces two application-level invariants:
 *
 * 1. **Immutable evidence requirement**: every concept MUST have at least one
 *    evidence item. An empty evidence array throws {@link InvalidConceptError}
 *    before touching the database.
 * 2. **Trusted-contributor filter**: only principals with provenance
 *    `webhook_verified` or `credential_bound` become contributors. Principals
 *    with `client_claimed` or `unknown` provenance are silently omitted — the
 *    database never records a client_claimed actor as a contributor (red line
 *    5.4 + Q5/N2).
 *
 * Additional guarantees enforced by the database:
 * - `concept_paths_namespace_uq`: path uniqueness within a project.
 * - `concept_paths_current_uq`: at most one current path per concept.
 * - Composite FKs: tenant-consistent references to concepts, principals, and
 *   projects.
 */
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';

// ── Error types ─────────────────────────────────────────────────────────────

/** Thrown when evidence array is empty — every concept page requires at least one. */
export class InvalidConceptError extends Error {
  readonly name = 'InvalidConceptError';
}

// ── Input types ─────────────────────────────────────────────────────────────

export interface ConceptEvidenceInput {
  readonly kind: 'commit' | 'pr' | 'issue' | 'pr_comment' | 'repo_file' | 'mcp_write' | 'manual';
  readonly ref?: string | null;
  readonly repo?: string | null;
  readonly commitSha?: string | null;
  readonly path?: string | null;
  readonly at: Date;
}

/**
 * A contributor candidate with provenance information.
 *
 * The repository uses provenance to decide whether this principal should
 * actually be recorded as a contributor. Only `webhook_verified` and
 * `credential_bound` are trusted; `client_claimed` and `unknown` are
 * silently omitted (never enter concept_contributors).
 */
export interface ConceptContributorInput {
  readonly principalId: string;
  readonly provenance: 'webhook_verified' | 'credential_bound' | 'client_claimed' | 'unknown';
}

export interface CreateConceptInput {
  readonly teamId: string;
  readonly projectId: string;
  readonly schemaVersion: number;
  readonly type: 'service' | 'concept' | 'decision' | 'gotcha' | 'convention' | 'runbook';
  readonly status: 'active' | 'superseded' | 'disputed' | 'needs-review';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly title: string;
  readonly body: string;
  readonly tags?: string[];
  readonly firstSeen: Date;
  readonly lastConfirmed: Date;
  readonly supersedesUuid?: string | null;
  /** The current path for this concept. Must be unique within the project. */
  readonly path: string;
  /** At least one evidence item required — empty → {@link InvalidConceptError}. */
  readonly evidence: ConceptEvidenceInput[];
  /** Contributor candidates — only trusted (webhook_verified / credential_bound) are persisted. */
  readonly contributors?: ConceptContributorInput[];
}

// ── Result type ─────────────────────────────────────────────────────────────

export interface CreateConceptResult {
  readonly uuid: string;
  readonly pathId: string;
  readonly evidenceIds: string[];
  readonly contributorCount: number;
}

// ── Trusted provenance filter ───────────────────────────────────────────────

const TRUSTED_PROVENANCE = new Set(['webhook_verified', 'credential_bound']);

// ── Repository function ─────────────────────────────────────────────────────

/**
 * Create a concept page with its current path, evidence, and trusted
 * contributors inside a single database transaction.
 *
 * If the evidence array is empty, throws {@link InvalidConceptError}
 * immediately — no database work is attempted.
 *
 * Path uniqueness and FK constraints are enforced by the database; a
 * constraint violation (duplicate path, missing principal/project, etc.)
 * rolls back the entire transaction automatically.
 *
 * @returns the created concept UUID, path ID, evidence IDs, and trusted
 *          contributor count for downstream use (job recording, audit).
 * @throws InvalidConceptError when evidence is empty.
 */
export async function createConcept(
  db: AppDb,
  input: CreateConceptInput,
): Promise<CreateConceptResult> {
  // Application-level invariant: every concept must have at least one evidence item.
  if (input.evidence.length === 0) {
    throw new InvalidConceptError('Concept must have at least one evidence item');
  }

  return db.transaction(async (tx) => {
    // 1. Insert the concept row.
    const [concept] = await tx
      .insert(schema.concepts)
      .values({
        teamId: input.teamId,
        projectId: input.projectId,
        schemaVersion: input.schemaVersion,
        type: input.type,
        status: input.status,
        confidence: input.confidence,
        title: input.title,
        body: input.body,
        tags: input.tags ?? [],
        firstSeen: input.firstSeen,
        lastConfirmed: input.lastConfirmed,
        supersedesUuid: input.supersedesUuid ?? null,
      })
      .returning({ uuid: schema.concepts.uuid });

    if (!concept) {
      throw new Error('concept insert returned no row');
    }
    const conceptUuid = concept.uuid;

    // 2. Insert the current path.
    const [pathRow] = await tx
      .insert(schema.conceptPaths)
      .values({
        teamId: input.teamId,
        projectId: input.projectId,
        conceptUuid,
        path: input.path,
        isCurrent: true,
      })
      .returning({ id: schema.conceptPaths.id });

    if (!pathRow) {
      throw new Error('concept path insert returned no row');
    }

    // 3. Insert evidence rows.
    const evidenceRows = await tx
      .insert(schema.conceptEvidence)
      .values(
        input.evidence.map((ev) => ({
          teamId: input.teamId,
          projectId: input.projectId,
          conceptUuid,
          kind: ev.kind,
          ref: ev.ref ?? null,
          repo: ev.repo ?? null,
          commitSha: ev.commitSha ?? null,
          path: ev.path ?? null,
          at: ev.at,
        })),
      )
      .returning({ id: schema.conceptEvidence.id });

    // 4. Insert trusted contributors only.
    let contributorCount = 0;
    const trustedContributors = (input.contributors ?? []).filter(
      (c) => TRUSTED_PROVENANCE.has(c.provenance),
    );

    if (trustedContributors.length > 0) {
      const contributorRows = await tx
        .insert(schema.conceptContributors)
        .values(
          trustedContributors.map((c) => ({
            teamId: input.teamId,
            projectId: input.projectId,
            conceptUuid,
            principalId: c.principalId,
          })),
        )
        .returning({ principalId: schema.conceptContributors.principalId });

      contributorCount = contributorRows.length;
    }

    return {
      uuid: conceptUuid,
      pathId: pathRow.id,
      evidenceIds: evidenceRows.map((r) => r.id),
      contributorCount,
    };
  });
}
