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
import { conceptPath, evidence as evidenceSchema } from '@teamem/schema';
import { ZodError } from 'zod';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';

// ── Error types ─────────────────────────────────────────────────────────────

/** Thrown when concept input fails frozen-contract validation (empty evidence,
 *  invalid path syntax, missing repo_file immutable fields, etc.). */
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
  /**
   * Optional 1536-dimensional embedding vector for semantic search.
   *
   * When the deployment capability is `vector`, the caller generates an
   * embedding from title + body and passes it here.  When capability is
   * `fts-only`, this field is omitted (undefined / null) and the database
   * stores SQL NULL — the legal degradation state (§5.5).
   *
   * The vector is validated to have exactly {@link EMBEDDING_DIMENSION}
   * (1536) elements by the embedding adapter before reaching this
   * repository; this layer trusts the caller.
   */
  readonly embedding?: number[] | null;
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
  // Application-level invariants: validate against frozen contract before
  // touching the database.  Zod parse failures become InvalidConceptError.

  // 1. Path must conform to conceptPath (N5: frozen syntax).
  try {
    conceptPath.parse(input.path);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new InvalidConceptError(
        `Invalid concept path: ${err.issues.map((e) => e.message).join('; ')}`,
      );
    }
    throw err;
  }

  // 2. At least one evidence item, and every item must satisfy the frozen
  //    evidence discriminated union (repo_file requires repo/commitSha/path;
  //    url kinds require a valid URL ref; mcp_write/manual require a ref).
  //    The frozen contract expects ISO 8601 strings for `at`; we accept Date
  //    objects in the input and convert them before validation.
  try {
    evidenceSchema
      .array()
      .nonempty()
      .parse(
        input.evidence.map((ev) => ({
          ...ev,
          at: ev.at instanceof Date ? ev.at.toISOString() : ev.at,
        })),
      );
  } catch (err) {
    if (err instanceof ZodError) {
      throw new InvalidConceptError(
        `Invalid evidence: ${err.issues.map((e) => e.message).join('; ')}`,
      );
    }
    throw err;
  }

  return db.transaction(async (tx) => {
    // 1. Insert the concept row.
    //
    // The `embedding` column is included only when a non-null vector is
    // provided.  The PgVector.mapToDriverValue uses JSON.stringify, which
    // would produce the string "null" for a JS null — an invalid vector
    // literal.  By omitting the key entirely when embedding is nullish, the
    // database stores SQL NULL, which is the correct fts-only degradation.
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
        ...(input.embedding != null ? { embedding: input.embedding } : {}),
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
