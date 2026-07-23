/**
 * Concept merge/rewrite repository — real-Postgres integration tests.
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres with migrations
 * 0000+0001 applied; honestly skipped otherwise — no mocked database, per
 * project red line.
 *
 * Covers:
 * - CLI 1: confirms merge → body changes, evidence increases, concept count unchanged
 * - CLI 2: extends does NOT refresh last_confirmed; confirms DOES refresh
 * - CLI 3: contradicts → status=disputed
 * - CLI 4: cross-team targetId merge rejected (404 semantic)
 * - Evidence deduplication
 * - Contributor dedup + trusted-provenance filter
 * - Embedding update
 * - Transaction atomicity on errors
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type AppDb } from '../client.js';
import * as schema from '../schema.js';
import {
  createConcept,
  type CreateConceptInput,
} from './concepts-write.js';
import {
  mergeIntoConcept,
  MergeTargetNotFoundError,
} from './concepts-merge.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('ConceptMergeRepository (live Postgres)', () => {
  let db: AppDb;
  const testTeam = 'team_cm_tests';
  const testProject = 'prj_cm_tests';

  // ── Seed data ──────────────────────────────────────────────────────────

  beforeAll(async () => {
    db = createDb(url!);
    // Team + project for this test suite.
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${testTeam}', 'CM Tests')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${testProject}', '${testTeam}', 'CM Project')
      ON CONFLICT (id) DO NOTHING;
    `);
    // Trusted principals.
    await db.execute(`
      INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
      VALUES
        ('pri_cm_alice', '${testTeam}', 'human', 'github', 'github', 'alice', 'alice'),
        ('pri_cm_bob',   '${testTeam}', 'human', 'github', 'github', 'bob',   'bob'),
        ('pri_cm_eve',   '${testTeam}', 'human', 'github', 'github', 'eve',   'eve')
      ON CONFLICT (id) DO NOTHING;
    `);
    // A second team for cross-tenant tests.
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('team_cm_other', 'CM Other')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('prj_cm_other', 'team_cm_other', 'CM Other Project')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
      VALUES ('pri_cm_other', 'team_cm_other', 'human', 'github', 'github', 'other', 'other')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    // Clean up in reverse dependency order.
    await db.execute(`
      DELETE FROM concept_contributors WHERE team_id = '${testTeam}';
      DELETE FROM concept_evidence      WHERE team_id = '${testTeam}';
      DELETE FROM concept_paths         WHERE team_id = '${testTeam}';
      DELETE FROM concepts              WHERE team_id = '${testTeam}';
      DELETE FROM principals            WHERE team_id = '${testTeam}';
      DELETE FROM projects              WHERE id = '${testProject}';
      DELETE FROM teams                 WHERE id = '${testTeam}';
      DELETE FROM concept_contributors WHERE team_id = 'team_cm_other';
      DELETE FROM concept_evidence      WHERE team_id = 'team_cm_other';
      DELETE FROM concept_paths         WHERE team_id = 'team_cm_other';
      DELETE FROM concepts              WHERE team_id = 'team_cm_other';
      DELETE FROM principals            WHERE team_id = 'team_cm_other';
      DELETE FROM projects              WHERE id = 'prj_cm_other';
      DELETE FROM teams                 WHERE id = 'team_cm_other';
    `);
  });

  beforeEach(async () => {
    // Clean only concept-related data between tests.
    await db.execute(`
      DELETE FROM concept_contributors WHERE team_id = '${testTeam}';
      DELETE FROM concept_evidence      WHERE team_id = '${testTeam}';
      DELETE FROM concept_paths         WHERE team_id = '${testTeam}';
      DELETE FROM concepts              WHERE team_id = '${testTeam}';
    `);
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  const validCreateInput = (overrides?: Partial<CreateConceptInput>): CreateConceptInput => ({
    teamId: testTeam,
    projectId: testProject,
    schemaVersion: 1,
    type: 'decision',
    status: 'active',
    confidence: 'high',
    title: 'Use TypeScript for backend',
    body: 'We decided to use TypeScript for the backend services.',
    tags: ['typescript', 'backend'],
    firstSeen: new Date('2025-01-01T00:00:00.000Z'),
    lastConfirmed: new Date('2025-01-01T00:00:00.000Z'),
    path: `use-typescript-${randomUUID()}`,
    evidence: [
      {
        kind: 'commit',
        ref: 'https://github.com/teamem-ai/teamem/commit/abc1234',
        at: new Date('2025-01-01T00:00:00.000Z'),
      },
    ],
    contributors: [
      { principalId: 'pri_cm_alice', provenance: 'credential_bound' },
    ],
    ...overrides,
  });

  const newEvidence = (): Array<{
    kind: 'commit' | 'pr' | 'issue' | 'pr_comment' | 'repo_file' | 'mcp_write' | 'manual';
    ref?: string | null;
    repo?: string | null;
    commitSha?: string | null;
    path?: string | null;
    at: Date;
  }> => [
    {
      kind: 'commit' as const,
      ref: 'https://github.com/teamem-ai/teamem/commit/def5678',
      at: new Date('2025-01-02T00:00:00.000Z'),
    },
  ];

  /**
   * Create a concept and return its UUID + initial state for merge testing.
   */
  async function createTestConcept(overrides?: Partial<CreateConceptInput>) {
    const result = await createConcept(db, validCreateInput(overrides));
    const [row] = await db
      .select()
      .from(schema.concepts)
      .where(eq(schema.concepts.uuid, result.uuid));
    if (!row) throw new Error('concept not found after create');
    return { uuid: result.uuid, row };
  }

  // ── CLI 1: confirms merge ──────────────────────────────────────────────

  describe('confirms merge (CLI 1)', () => {
    it('updates body, appends evidence, and keeps concept count unchanged', async () => {
      const { uuid } = await createTestConcept();

      // Count concepts before.
      const beforeCount = await db
        .select({ n: schema.concepts.uuid })
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, testTeam));
      const beforeN = beforeCount.length;

      // Count evidence before.
      const beforeEv = await db
        .select({ id: schema.conceptEvidence.id })
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, uuid));
      const beforeEvN = beforeEv.length;

      const result = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'confirms',
        mergedTitle: 'Use TypeScript for backend (confirmed)',
        mergedBody:
          'We decided to use TypeScript for the backend services. Additional evidence confirms this direction.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
        newContributors: [
          { principalId: 'pri_cm_bob', provenance: 'webhook_verified' },
        ],
      });

      expect(result.uuid).toBe(uuid);
      expect(result.bodyUpdated).toBe(true);
      expect(result.newEvidenceCount).toBe(1);
      expect(result.newContributorCount).toBe(1);

      // Verify body changed.
      const [updated] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(updated).toBeTruthy();
      expect(updated!.title).toContain('confirmed');
      expect(updated!.body).toContain('Additional evidence confirms');

      // Verify evidence increased.
      const afterEv = await db
        .select({ id: schema.conceptEvidence.id })
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, uuid));
      expect(afterEv.length).toBe(beforeEvN + 1);

      // CLI 1 assertion: concepts row count unchanged.
      const afterCount = await db
        .select({ n: schema.concepts.uuid })
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, testTeam));
      expect(afterCount.length).toBe(beforeN);

      // Verify contributor appended.
      const contributors = await db
        .select()
        .from(schema.conceptContributors)
        .where(eq(schema.conceptContributors.conceptUuid, uuid));
      const pids = contributors.map((c) => c.principalId).sort();
      expect(pids).toContain('pri_cm_alice');
      expect(pids).toContain('pri_cm_bob');
    });

    it('updates last_confirmed when confirms (Q10)', async () => {
      const pastDate = new Date('2025-01-01T00:00:00.000Z');
      const { uuid } = await createTestConcept({
        lastConfirmed: pastDate,
      });

      const before = new Date();

      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'confirms',
        mergedTitle: 'Updated',
        mergedBody: 'Updated body.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
      });

      const [updated] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(updated).toBeTruthy();

      // last_confirmed should be after our "before" marker (it was refreshed).
      expect(updated!.lastConfirmed.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
    });
  });

  // ── CLI 2: extends does NOT refresh last_confirmed ─────────────────────

  describe('extends merge (CLI 2)', () => {
    it('updates body and appends evidence but does NOT refresh last_confirmed', async () => {
      const pastDate = new Date('2025-01-01T00:00:00.000Z');
      const { uuid } = await createTestConcept({
        lastConfirmed: pastDate,
      });

      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Use TypeScript for backend (extended)',
        mergedBody:
          'We decided to use TypeScript for the backend services. We also use strict mode.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
        newContributors: [
          { principalId: 'pri_cm_bob', provenance: 'credential_bound' },
        ],
      });

      const [updated] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(updated).toBeTruthy();

      // Body should be updated.
      expect(updated!.body).toContain('strict mode');

      // last_confirmed must NOT change — still exactly the old date.
      expect(updated!.lastConfirmed.getTime()).toBe(pastDate.getTime());

      // Evidence should be appended.
      const evidenceRows = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, uuid));
      expect(evidenceRows.length).toBe(2);
    });

    it('extends does NOT set lastConfirmedUpdated flag', async () => {
      const { uuid } = await createTestConcept();

      const result = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Updated',
        mergedBody: 'Updated.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
      });

      expect(result.lastConfirmedUpdated).toBe(false);
    });

    it('confirms DOES set lastConfirmedUpdated flag', async () => {
      const { uuid } = await createTestConcept();

      const result = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'confirms',
        mergedTitle: 'Updated',
        mergedBody: 'Updated.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
      });

      expect(result.lastConfirmedUpdated).toBe(true);
    });
  });

  // ── CLI 3: contradicts → disputed ─────────────────────────────────────

  describe('contradicts merge (CLI 3)', () => {
    it('sets status to disputed and does NOT refresh last_confirmed', async () => {
      const pastDate = new Date('2025-01-01T00:00:00.000Z');
      const { uuid } = await createTestConcept({
        status: 'active',
        lastConfirmed: pastDate,
      });

      const result = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'contradicts',
        mergedTitle: 'Use TypeScript for backend (DISPUTED)',
        mergedBody:
          'Original: We decided to use TypeScript.\n\nContradiction: New evidence suggests Go may be better for this use case.',
        resultStatus: 'disputed', // LLM is forced to return this by Zod, but we test defense in depth
        newEvidence: newEvidence(),
      });

      expect(result.statusDisputed).toBe(true);

      const [updated] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(updated).toBeTruthy();
      expect(updated!.status).toBe('disputed');
      expect(updated!.body).toContain('Contradiction');

      // last_confirmed must NOT be refreshed.
      expect(updated!.lastConfirmed.getTime()).toBe(pastDate.getTime());
    });

    it('forces disputed status even if LLM returns a different status (defense in depth)', async () => {
      const { uuid } = await createTestConcept({ status: 'active' });

      // Intentionally pass a non-disputed resultStatus with contradicts.
      // The repository must override it.
      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'contradicts',
        mergedTitle: 'Test',
        mergedBody: 'Test.',
        resultStatus: 'active' as 'disputed', // wrong! but the repo forces disputed
        newEvidence: newEvidence(),
      });

      const [updated] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(updated!.status).toBe('disputed');
    });
  });

  // ── CLI 4: cross-team isolation ───────────────────────────────────────

  describe('cross-team isolation (CLI 4)', () => {
    it('rejects merge when target belongs to a different team', async () => {
      // Create a concept in team_cm_tests.
      const { uuid } = await createTestConcept();

      // Attempt merge with a wrong team_id — should throw MergeTargetNotFoundError.
      await expect(
        mergeIntoConcept(db, {
          teamId: 'team_cm_other', // different team
          projectId: testProject,
          targetId: uuid,
          relationship: 'confirms',
          mergedTitle: 'X',
          mergedBody: 'X.',
          resultStatus: 'active',
          newEvidence: newEvidence(),
        }),
      ).rejects.toThrow(MergeTargetNotFoundError);
    });

    it('rejects merge when target belongs to a different project (same team)', async () => {
      // Create a concept in testTeam/testProject.
      const { uuid } = await createTestConcept();

      // Attempt merge with a different project_id — should throw.
      await expect(
        mergeIntoConcept(db, {
          teamId: testTeam,
          projectId: 'prj_cm_other', // different project, same team — but projects belong to different teams
          targetId: uuid,
          relationship: 'confirms',
          mergedTitle: 'X',
          mergedBody: 'X.',
          resultStatus: 'active',
          newEvidence: newEvidence(),
        }),
      ).rejects.toThrow(MergeTargetNotFoundError);
    });

    it('rejects merge with nonexistent UUID (same 404 semantic as cross-team)', async () => {
      await expect(
        mergeIntoConcept(db, {
          teamId: testTeam,
          projectId: testProject,
          targetId: '00000000-0000-0000-0000-000000000000',
          relationship: 'confirms',
          mergedTitle: 'X',
          mergedBody: 'X.',
          resultStatus: 'active',
          newEvidence: newEvidence(),
        }),
      ).rejects.toThrow(MergeTargetNotFoundError);
    });
  });

  // ── Evidence deduplication ─────────────────────────────────────────────

  describe('evidence deduplication', () => {
    it('does not insert duplicate evidence (same kind, ref, at)', async () => {
      const { uuid } = await createTestConcept();

      // First merge — adds evidence.
      const result1 = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Updated',
        mergedBody: 'Updated.',
        resultStatus: 'active',
        newEvidence: [
          {
            kind: 'commit',
            ref: 'https://github.com/teamem-ai/teamem/commit/dup12345',
            at: new Date('2025-02-01T00:00:00.000Z'),
          },
        ],
      });
      expect(result1.newEvidenceCount).toBe(1);

      // Second merge — same evidence should be deduplicated.
      const result2 = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Updated again',
        mergedBody: 'Updated again.',
        resultStatus: 'active',
        newEvidence: [
          {
            kind: 'commit',
            ref: 'https://github.com/teamem-ai/teamem/commit/dup12345',
            at: new Date('2025-02-01T00:00:00.000Z'),
          },
        ],
      });
      expect(result2.newEvidenceCount).toBe(0);

      // Total evidence should be: 1 original + 1 from first merge = 2.
      const evidenceRows = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, uuid));
      expect(evidenceRows.length).toBe(2);
    });

    it('deduplicates evidence within a single merge batch', async () => {
      const { uuid } = await createTestConcept();

      const result = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'With batch',
        mergedBody: 'Batch evidence.',
        resultStatus: 'active',
        newEvidence: [
          {
            kind: 'pr',
            ref: 'https://github.com/teamem-ai/teamem/pull/42',
            at: new Date('2025-03-01T00:00:00.000Z'),
          },
          {
            kind: 'pr',
            ref: 'https://github.com/teamem-ai/teamem/pull/42',
            at: new Date('2025-03-01T00:00:00.000Z'),
          },
        ],
      });

      // Only 1 should be inserted (the duplicate within the batch is skipped).
      expect(result.newEvidenceCount).toBe(1);
    });
  });

  // ── repo_file evidence required-field validation ──────────────────────

  describe('repo_file evidence validation', () => {
    it('rejects repo_file evidence without repo field', async () => {
      const { uuid } = await createTestConcept();

      await expect(
        mergeIntoConcept(db, {
          teamId: testTeam,
          projectId: testProject,
          targetId: uuid,
          relationship: 'extends',
          mergedTitle: 'X',
          mergedBody: 'X.',
          resultStatus: 'active',
          newEvidence: [
            {
              kind: 'repo_file',
              commitSha: 'abc1234',
              path: 'src/index.ts',
              at: new Date('2025-06-01T00:00:00.000Z'),
            } as never,
          ],
        }),
      ).rejects.toThrow(/repo_file/);
    });

    it('rejects repo_file evidence without commitSha', async () => {
      const { uuid } = await createTestConcept();

      await expect(
        mergeIntoConcept(db, {
          teamId: testTeam,
          projectId: testProject,
          targetId: uuid,
          relationship: 'extends',
          mergedTitle: 'X',
          mergedBody: 'X.',
          resultStatus: 'active',
          newEvidence: [
            {
              kind: 'repo_file',
              repo: 'teamem-ai/teamem',
              path: 'src/index.ts',
              at: new Date('2025-06-01T00:00:00.000Z'),
            } as never,
          ],
        }),
      ).rejects.toThrow(/repo_file/);
    });

    it('rejects repo_file evidence without path', async () => {
      const { uuid } = await createTestConcept();

      await expect(
        mergeIntoConcept(db, {
          teamId: testTeam,
          projectId: testProject,
          targetId: uuid,
          relationship: 'extends',
          mergedTitle: 'X',
          mergedBody: 'X.',
          resultStatus: 'active',
          newEvidence: [
            {
              kind: 'repo_file',
              repo: 'teamem-ai/teamem',
              commitSha: 'abc1234',
              at: new Date('2025-06-01T00:00:00.000Z'),
            } as never,
          ],
        }),
      ).rejects.toThrow(/repo_file/);
    });
  });

  // ── Contributor deduplication and trusted filter ───────────────────────

  describe('contributor handling', () => {
    it('deduplicates contributors via PK (same principalId)', async () => {
      const { uuid } = await createTestConcept({
        contributors: [
          { principalId: 'pri_cm_alice', provenance: 'credential_bound' },
        ],
      });

      // Merge adding Alice again — should be deduplicated.
      const result = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Updated',
        mergedBody: 'Updated.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
        newContributors: [
          { principalId: 'pri_cm_alice', provenance: 'credential_bound' },
          { principalId: 'pri_cm_bob', provenance: 'credential_bound' },
        ],
      });

      // Bob is new, Alice already exists → only 1 new.
      expect(result.newContributorCount).toBe(1);

      const contributors = await db
        .select()
        .from(schema.conceptContributors)
        .where(eq(schema.conceptContributors.conceptUuid, uuid));
      expect(contributors.length).toBe(2); // Alice + Bob
    });

    it('excludes client_claimed contributors (same rule as createConcept)', async () => {
      const { uuid } = await createTestConcept();

      const result = await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Updated',
        mergedBody: 'Updated.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
        newContributors: [
          { principalId: 'pri_cm_bob', provenance: 'credential_bound' },
          { principalId: 'pri_cm_eve', provenance: 'client_claimed' }, // must be excluded
        ],
      });

      expect(result.newContributorCount).toBe(1);

      const contributors = await db
        .select()
        .from(schema.conceptContributors)
        .where(eq(schema.conceptContributors.conceptUuid, uuid));
      const pids = contributors.map((c) => c.principalId);
      expect(pids).toContain('pri_cm_alice'); // original
      expect(pids).toContain('pri_cm_bob'); // trusted
      expect(pids).not.toContain('pri_cm_eve'); // excluded
    });
  });

  // ── Embedding update ──────────────────────────────────────────────────

  describe('embedding update', () => {
    it('replaces existing embedding when newEmbedding is provided', async () => {
      const oldEmbedding = Array.from({ length: 1536 }, () => 0.1);
      const { uuid } = await createTestConcept({ embedding: oldEmbedding });

      const newEmbedding = Array.from({ length: 1536 }, () => 0.9);

      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Updated',
        mergedBody: 'Updated body for new embedding.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
        newEmbedding,
      });

      const [updated] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(updated!.embedding).not.toBeNull();
      expect(updated!.embedding![0]).toBeCloseTo(0.9, 1);
    });

    it('leaves existing embedding unchanged when newEmbedding is not provided', async () => {
      const oldEmbedding = Array.from({ length: 1536 }, () => 0.5);
      const { uuid } = await createTestConcept({ embedding: oldEmbedding });

      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Updated',
        mergedBody: 'Updated body without new embedding.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
        // newEmbedding NOT provided
      });

      const [updated] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(updated!.embedding![0]).toBeCloseTo(0.5, 1);
    });

    it('treats null newEmbedding same as undefined (leaves existing untouched)', async () => {
      const oldEmbedding = Array.from({ length: 1536 }, () => 0.3);
      const { uuid } = await createTestConcept({ embedding: oldEmbedding });

      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'Updated',
        mergedBody: 'Updated body.',
        resultStatus: 'active',
        newEvidence: newEvidence(),
        newEmbedding: null, // null is nullish → skip, leave existing untouched
      });

      const [updated] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      // Existing embedding is preserved (null is treated as "not provided").
      expect(updated!.embedding![0]).toBeCloseTo(0.3, 1);
    });
  });

  // ── Transaction atomicity ──────────────────────────────────────────────

  describe('transaction atomicity', () => {
    it('does not partially update on cross-team principal FK violation', async () => {
      const { uuid } = await createTestConcept();

      // Attempt merge with a principal from another team — FK should fail
      // and roll back everything.
      const originalBody = (
        await db
          .select({ body: schema.concepts.body })
          .from(schema.concepts)
          .where(eq(schema.concepts.uuid, uuid))
      )[0]!.body;

      await expect(
        mergeIntoConcept(db, {
          teamId: testTeam,
          projectId: testProject,
          targetId: uuid,
          relationship: 'extends',
          mergedTitle: 'SHOULD ROLL BACK',
          mergedBody: 'SHOULD ROLL BACK',
          resultStatus: 'active',
          newEvidence: newEvidence(),
          newContributors: [
            { principalId: 'pri_cm_other', provenance: 'credential_bound' }, // different team!
          ],
        }),
      ).rejects.toThrow();

      // Body must NOT have changed.
      const [after] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(after!.body).toBe(originalBody);
      expect(after!.title).not.toContain('ROLL BACK');
    });
  });

  // ── Multiple merges ────────────────────────────────────────────────────

  describe('multiple sequential merges', () => {
    it('correctly accumulates evidence and contributors across multiple merges', async () => {
      const { uuid } = await createTestConcept();

      // Merge 1: extends
      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'extends',
        mergedTitle: 'V2',
        mergedBody: 'V2 body.',
        resultStatus: 'active',
        newEvidence: [
          {
            kind: 'pr',
            ref: 'https://github.com/teamem-ai/teamem/pull/1',
            at: new Date('2025-03-01T00:00:00.000Z'),
          },
        ],
        newContributors: [
          { principalId: 'pri_cm_bob', provenance: 'credential_bound' },
        ],
      });

      // Merge 2: confirms
      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'confirms',
        mergedTitle: 'V3',
        mergedBody: 'V3 body.',
        resultStatus: 'active',
        newEvidence: [
          {
            kind: 'issue',
            ref: 'https://github.com/teamem-ai/teamem/issues/99',
            at: new Date('2025-04-01T00:00:00.000Z'),
          },
        ],
      });

      // Merge 3: contradicts, adds Eve as contributor
      await mergeIntoConcept(db, {
        teamId: testTeam,
        projectId: testProject,
        targetId: uuid,
        relationship: 'contradicts',
        mergedTitle: 'V4 DISPUTED',
        mergedBody: 'Now disputed.',
        resultStatus: 'disputed',
        newEvidence: [
          {
            kind: 'mcp_write',
            ref: 'evt_mcp_01',
            at: new Date('2025-05-01T00:00:00.000Z'),
          },
        ],
        newContributors: [
          { principalId: 'pri_cm_eve', provenance: 'credential_bound' },
        ],
      });

      // Final state: disputed, 1 original + 3 new evidence = 4 total, 3 contributors.
      const [final] = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, uuid));
      expect(final!.status).toBe('disputed');
      expect(final!.body).toBe('Now disputed.');

      const evidence = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, uuid));
      expect(evidence.length).toBe(4);

      const contributors = await db
        .select()
        .from(schema.conceptContributors)
        .where(eq(schema.conceptContributors.conceptUuid, uuid));
      expect(contributors.length).toBe(3); // Alice, Bob, Eve
    });
  });
});
