/**
 * Concept merge/rewrite repository (DUA-200 M1-F2-04).
 *
 * Implements F2 decision persistence: merges a new piece of knowledge into
 * an existing concept page (confirms/extends) or marks it disputed
 * (contradicts). The "unrelated" branch is handled by the existing
 * {@link createConcept} — this module only deals with updates to an
 * already-existing concept.
 *
 * Key invariants enforced here:
 *
 * 1. **Page count never grows on merge** — confirms/extends/contradicts
 *    update the existing row; they never create a new concept.
 *
 * 2. **Q10 last_confirmed semantics** — `last_confirmed` is updated ONLY
 *    when the relationship is "confirms" (new evidence corroborates the
 *    existing claim). "extends" adds detail without corroboration, so
 *    `last_confirmed` stays as-is. "contradicts" marks the concept as
 *    disputed and must NOT refresh `last_confirmed`.
 *
 * 3. **Evidence preservation** — all existing evidence rows are retained;
 *    new evidence rows are appended after deduplication (same concept +
 *    same kind + same ref/repo/commitSha/path + same at → skip).
 *
 * 4. **Trusted-contributor filter** — only principals with provenance
 *    `webhook_verified` or `credential_bound` are added as contributors
 *    (same rule as {@link createConcept}). The database primary key on
 *    (conceptUuid, principalId) handles deduplication.
 *
 * 5. **contradicts → disputed** — the status is set to `disputed`
 *    regardless of what the LLM returns in resultStatus (the Zod schema
 *    already forces `disputed` on contradicts, but the DB layer enforces
 *    it as a second line of defense).
 *
 * 6. **Embedding recomputation** — when a new embedding vector is provided
 *    (typically from EMB-04 after the body rewrite), it replaces the
 *    existing embedding. When absent, the existing embedding is left
 *    untouched (the caller is responsible for keeping it in sync).
 */

import { and, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { AppDb } from '../client.js';
import { InvalidConceptError, type ConceptEvidenceInput, type ConceptContributorInput } from './concepts-write.js';

// ── Error types ─────────────────────────────────────────────────────────────

/** Thrown when the target concept does not exist (or belongs to a different
 *  team/project — indistinguishable by design for anti-enumeration). */
export class MergeTargetNotFoundError extends Error {
  readonly name = 'MergeTargetNotFoundError';
  constructor() {
    super('Target concept not found — it may not exist or belong to a different team/project');
  }
}

// ── Input types ─────────────────────────────────────────────────────────────

export interface MergeIntoConceptInput {
  /** Mandatory team id (red line 5.5). */
  readonly teamId: string;
  /** Mandatory project id. */
  readonly projectId: string;
  /** Target concept UUID — the existing page to merge into. */
  readonly targetId: string;
  /** F2 relationship: confirms / extends / contradicts. Unrelated is NOT
   *  handled here — use {@link createConcept} for new pages. */
  readonly relationship: 'confirms' | 'extends' | 'contradicts';
  /** The merged title from the LLM decision. */
  readonly mergedTitle: string;
  /** The complete merged markdown body from the LLM decision. */
  readonly mergedBody: string;
  /** The resulting concept status from the LLM decision.
   *  For contradicts this is always 'disputed' (enforced by the Zod schema
   *  AND re-enforced here as defense in depth). */
  readonly resultStatus: 'active' | 'superseded' | 'disputed' | 'needs-review';
  /** New evidence items from the ingestion event (appended, not replaced). */
  readonly newEvidence: ConceptEvidenceInput[];
  /** New contributor candidates (trusted-filtered, deduplicated by PK). */
  readonly newContributors?: ConceptContributorInput[];
  /**
   * Optional new embedding vector for the merged body (EMB-04 path).
   *
   * When provided, replaces the existing embedding. When null/undefined,
   * the existing embedding is left untouched (the caller is responsible
   * for keeping it in sync with the body content).
   */
  readonly newEmbedding?: number[] | null;
}

// ── Result type ─────────────────────────────────────────────────────────────

export interface MergeIntoConceptResult {
  /** The target concept UUID (same as input). */
  readonly uuid: string;
  /** Number of new evidence rows actually inserted (after dedup). */
  readonly newEvidenceCount: number;
  /** Number of new contributor rows actually inserted (after filter + dedup). */
  readonly newContributorCount: number;
  /** Whether the concept body was updated (always true for success). */
  readonly bodyUpdated: boolean;
  /** Whether last_confirmed was refreshed (only for confirms). */
  readonly lastConfirmedUpdated: boolean;
  /** Whether status changed to disputed. */
  readonly statusDisputed: boolean;
}

// ── Trusted provenance filter ───────────────────────────────────────────────

const TRUSTED_PROVENANCE = new Set(['webhook_verified', 'credential_bound']);

// ── Repository function ─────────────────────────────────────────────────────

/**
 * Merge a new piece of knowledge into an existing concept page.
 *
 * This is the persistence-side of the F2 merge decision. The caller
 * (F2 compiler) has already:
 * 1. Received the structured F2 decision from the strong-model LLM
 * 2. Validated it against the {@link import('../../compiler/f2/decision.js').f2Decision} schema
 * 3. Generated a new embedding for the merged body (EMB-04 path) if
 *    semantic capability is available
 *
 * This function executes the write in a single database transaction:
 * 1. Verifies the target concept exists within the given scope
 * 2. For confirms/extends: updates title, body, status, and optionally
 *    embedding and last_confirmed
 * 3. For contradicts: updates title, body, sets status=disputed, does
 *    NOT refresh last_confirmed
 * 4. Appends new evidence (deduplicated against existing rows)
 * 5. Appends trusted contributors (PK deduplication handles duplicates)
 *
 * @throws MergeTargetNotFoundError when the target concept doesn't exist
 *         or belongs to a different team/project.
 */
export async function mergeIntoConcept(
  db: AppDb,
  input: MergeIntoConceptInput,
): Promise<MergeIntoConceptResult> {
  // The `unrelated` relationship is excluded from the input type at
  // compile time — it is the caller's responsibility to route unrelated
  // concepts to {@link createConcept}, not to this function.

  return db.transaction(async (tx) => {
    // 1. Look up the target concept with scope enforcement.
    const [existing] = await tx
      .select({
        uuid: schema.concepts.uuid,
        status: schema.concepts.status,
        lastConfirmed: schema.concepts.lastConfirmed,
      })
      .from(schema.concepts)
      .where(
        and(
          eq(schema.concepts.teamId, input.teamId),
          eq(schema.concepts.projectId, input.projectId),
          eq(schema.concepts.uuid, input.targetId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new MergeTargetNotFoundError();
    }

    // 2. Determine status: for contradicts, always force 'disputed'
    //    (defense in depth — the Zod schema also enforces this).
    const effectiveStatus =
      input.relationship === 'contradicts' ? 'disputed' : input.resultStatus;

    // 3. Determine whether to refresh last_confirmed.
    //    Q10: only "confirms" (corroboration) refreshes last_confirmed.
    //    "extends" adds detail without corroboration → no refresh.
    //    "contradicts" marks disputed → no refresh.
    const shouldRefreshLastConfirmed = input.relationship === 'confirms';
    const newLastConfirmed = shouldRefreshLastConfirmed
      ? new Date()
      : existing.lastConfirmed;

    // 4. Build the update payload.
    const updatePayload: Record<string, unknown> = {
      title: input.mergedTitle,
      body: input.mergedBody,
      status: effectiveStatus,
      lastConfirmed: newLastConfirmed,
      updatedAt: new Date(),
    };

    // Include new embedding when provided.
    if (input.newEmbedding !== undefined && input.newEmbedding !== null) {
      updatePayload['embedding'] = input.newEmbedding;
    }

    // 5. Update the concept row — scope filter carries team_id + project_id
    //    (red line §5.5: every write query must carry team_id; the SELECT
    //    above does not hold a row lock, so the UPDATE re-verifies scope
    //    at write time for defense in depth).
    await tx
      .update(schema.concepts)
      .set(updatePayload)
      .where(
        and(
          eq(schema.concepts.teamId, input.teamId),
          eq(schema.concepts.projectId, input.projectId),
          eq(schema.concepts.uuid, input.targetId),
        ),
      );

    // 6. Append new evidence (with deduplication against existing rows).
    let newEvidenceCount = 0;
    if (input.newEvidence.length > 0) {
      // Fetch existing evidence for dedup comparison.
      const existingEvidence = await tx
        .select({
          kind: schema.conceptEvidence.kind,
          ref: schema.conceptEvidence.ref,
          repo: schema.conceptEvidence.repo,
          commitSha: schema.conceptEvidence.commitSha,
          path: schema.conceptEvidence.path,
          at: schema.conceptEvidence.at,
        })
        .from(schema.conceptEvidence)
        .where(
          and(
            eq(schema.conceptEvidence.teamId, input.teamId),
            eq(schema.conceptEvidence.projectId, input.projectId),
            eq(schema.conceptEvidence.conceptUuid, input.targetId),
          ),
        );

      // Build a Set of fingerprints for O(1) dedup lookups.
      const existingFingerprints = new Set(
        existingEvidence.map((ev) =>
          evidenceFingerprint({
            kind: ev.kind,
            ref: ev.ref,
            repo: ev.repo,
            commitSha: ev.commitSha,
            path: ev.path,
            at: ev.at,
          }),
        ),
      );

      // Filter out duplicates.
      const toInsert = input.newEvidence.filter((ev) => {
        const fp = evidenceFingerprint(ev);
        if (existingFingerprints.has(fp)) return false;
        existingFingerprints.add(fp); // prevent internal duplicates in the batch
        return true;
      });

      if (toInsert.length > 0) {
        // Guard: repo_file evidence MUST carry immutable repo, commitSha, and
        // path (§6.1 frozen contract). Validate before touching the database.
        for (const ev of toInsert) {
          if (ev.kind === 'repo_file') {
            if (!ev.repo || !ev.commitSha || !ev.path) {
              throw new InvalidConceptError(
                'repo_file evidence requires repo, commitSha, and path',
              );
            }
          }
        }

        const inserted = await tx
          .insert(schema.conceptEvidence)
          .values(
            toInsert.map((ev) => ({
              teamId: input.teamId,
              projectId: input.projectId,
              conceptUuid: input.targetId,
              kind: ev.kind,
              ref: ev.ref ?? null,
              repo: ev.repo ?? null,
              commitSha: ev.commitSha ?? null,
              path: ev.path ?? null,
              at: ev.at,
            })),
          )
          .returning({ id: schema.conceptEvidence.id });

        newEvidenceCount = inserted.length;
      }
    }

    // 7. Append trusted contributors (PK dedup handles duplicates).
    let newContributorCount = 0;
    const trustedContributors = (input.newContributors ?? []).filter(
      (c) => TRUSTED_PROVENANCE.has(c.provenance),
    );

    if (trustedContributors.length > 0) {
      // Use ON CONFLICT DO NOTHING to handle PK (conceptUuid, principalId) dedup.
      // We issue individual INSERTs in a single statement to leverage the PK.
      const contributorRows = await tx
        .insert(schema.conceptContributors)
        .values(
          trustedContributors.map((c) => ({
            teamId: input.teamId,
            projectId: input.projectId,
            conceptUuid: input.targetId,
            principalId: c.principalId,
          })),
        )
        .onConflictDoNothing()
        .returning({ principalId: schema.conceptContributors.principalId });

      newContributorCount = contributorRows.length;
    }

    return {
      uuid: input.targetId,
      newEvidenceCount,
      newContributorCount,
      bodyUpdated: true,
      lastConfirmedUpdated: shouldRefreshLastConfirmed,
      statusDisputed: effectiveStatus === 'disputed',
    };
  });
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Build a stable, collision-resistant fingerprint string for evidence
 * deduplication. Two evidence items are considered duplicates when they
 * share the same kind, the same non-null reference fields, and the same
 * `at` timestamp (truncated to seconds to allow for minor precision
 * differences in serialization).
 *
 * This is an application-level dedup strategy — the database does not
 * enforce a unique constraint on evidence rows (by design: the same
 * commit may be cited as evidence for multiple concepts).
 */
function evidenceFingerprint(ev: {
  kind: string;
  ref?: string | null;
  repo?: string | null;
  commitSha?: string | null;
  path?: string | null;
  at: Date;
}): string {
  const atSec = ev.at instanceof Date
    ? Math.floor(ev.at.getTime() / 1000)
    : Math.floor(new Date(ev.at).getTime() / 1000);

  // Escape backslashes and the separator character so a pipe in a ref or
  // path value cannot cause a false-positive deduplication collision.
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

  const parts = [
    escape(ev.kind),
    escape(ev.ref ?? ''),
    escape(ev.repo ?? ''),
    escape(ev.commitSha ?? ''),
    escape(ev.path ?? ''),
    String(atSec),
  ];
  return parts.join('|');
}
