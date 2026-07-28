/**
 * Concept page write repository — real-Postgres integration tests.
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres with migrations
 * 0000+0001 applied; honestly skipped otherwise — no mocked database, per
 * project red line.
 *
 * Covers:
 * - Success path: concept + path + evidence + trusted contributors
 * - Empty evidence rejection
 * - Duplicate path rejection
 * - client_claimed actor exclusion from contributors
 * - Cross-team principal FK rejection
 * - Multiple evidence and contributor rows
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type AppDb } from '../client.js';
import * as schema from '../schema.js';
import {
  createConcept,
  InvalidConceptError,
  type CreateConceptInput,
} from './concepts-write.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('ConceptWriteRepository (live Postgres)', () => {
  let db: AppDb;
  const testTeam = 'team_cw_tests';
  const testProject = 'prj_cw_tests';

  // ── Seed data ──────────────────────────────────────────────────────────

  beforeAll(async () => {
    db = createDb(url!);
    // Team + project for this test suite.
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${testTeam}', 'CW Tests')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${testProject}', '${testTeam}', 'CW Project')
      ON CONFLICT (id) DO NOTHING;
    `);
    // Trusted principals (credential_bound).
    await db.execute(`
      INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
      VALUES
        ('pri_cw_alice', '${testTeam}', 'human', 'github', 'github', 'alice', 'alice'),
        ('pri_cw_bob',   '${testTeam}', 'human', 'github', 'github', 'bob',   'bob'),
        ('pri_cw_eve',   '${testTeam}', 'human', 'github', 'github', 'eve',   'eve')
      ON CONFLICT (id) DO NOTHING;
    `);
    // A second team for cross-tenant tests.
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('team_cw_other', 'CW Other')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
      VALUES ('pri_cw_other', 'team_cw_other', 'human', 'github', 'github', 'other', 'other')
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
      DELETE FROM principals            WHERE team_id = 'team_cw_other';
      DELETE FROM teams                 WHERE id = 'team_cw_other';
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

  // ── Helper: build a minimal valid input ────────────────────────────────

  const validInput = (overrides?: Partial<CreateConceptInput>): CreateConceptInput => ({
    teamId: testTeam,
    projectId: testProject,
    schemaVersion: 1,
    type: 'service',
    status: 'active',
    confidence: 'high',
    title: 'Test Service',
    body: 'A test concept page.',
    tags: ['test', 'example'],
    firstSeen: new Date('2025-01-01T00:00:00.000Z'),
    lastConfirmed: new Date('2025-01-02T00:00:00.000Z'),
    path: `test-service-${randomUUID()}`,
    evidence: [
      {
        kind: 'repo_file',
        repo: 'teamem-ai/teamem',
        commitSha: 'abc1234',
        path: 'src/index.ts',
        at: new Date('2025-01-01T00:00:00.000Z'),
      },
    ],
    contributors: [
      { principalId: 'pri_cw_alice', provenance: 'credential_bound' },
    ],
    ...overrides,
  });

  // ── Success path ───────────────────────────────────────────────────────

  describe('success path', () => {
    it('creates concept, path, evidence, and trusted contributors in one transaction', async () => {
      const path = `svc-success-${randomUUID()}`;
      const result = await createConcept(
        db,
        validInput({
          path,
          contributors: [
            { principalId: 'pri_cw_alice', provenance: 'credential_bound' },
            { principalId: 'pri_cw_bob', provenance: 'webhook_verified' },
          ],
        }),
      );

      // Verify result shape.
      expect(result.uuid).toBeTruthy();
      expect(result.pathId).toBeTruthy();
      expect(result.evidenceIds).toHaveLength(1);
      expect(result.contributorCount).toBe(2);

      // Verify concept row.
      const concepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, result.uuid));
      expect(concepts).toHaveLength(1);
      const c = concepts[0]!;
      expect(c.title).toBe('Test Service');
      expect(c.type).toBe('service');
      expect(c.status).toBe('active');
      expect(c.confidence).toBe('high');
      expect(c.tags).toEqual(['test', 'example']);

      // Verify path row.
      const paths = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.conceptUuid, result.uuid));
      expect(paths).toHaveLength(1);
      const p = paths[0]!;
      expect(p.path).toBe(path);
      expect(p.isCurrent).toBe(true);

      // Verify evidence row.
      const evidence = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, result.uuid));
      expect(evidence).toHaveLength(1);
      const ev = evidence[0]!;
      expect(ev.kind).toBe('repo_file');
      expect(ev.repo).toBe('teamem-ai/teamem');
      expect(ev.commitSha).toBe('abc1234');

      // Verify contributor rows.
      const contributors = await db
        .select()
        .from(schema.conceptContributors)
        .where(eq(schema.conceptContributors.conceptUuid, result.uuid));
      expect(contributors).toHaveLength(2);
      const pids = contributors.map((c) => c.principalId).sort();
      expect(pids).toEqual(['pri_cw_alice', 'pri_cw_bob']);
    });

    it('creates concept with multiple evidence items', async () => {
      const path = `svc-multi-ev-${randomUUID()}`;
      const result = await createConcept(
        db,
        validInput({
          path,
          evidence: [
            {
              kind: 'repo_file',
              repo: 'teamem-ai/teamem',
              commitSha: 'abc1234',
              path: 'src/a.ts',
              at: new Date('2025-01-01T00:00:00.000Z'),
            },
            {
              kind: 'commit',
              ref: 'https://github.com/teamem-ai/teamem/commit/abc1234',
              at: new Date('2025-01-01T00:00:00.000Z'),
            },
            {
              kind: 'mcp_write',
              ref: 'evt_mcp_write_01',
              at: new Date('2025-01-01T00:00:00.000Z'),
            },
          ],
        }),
      );

      expect(result.evidenceIds).toHaveLength(3);
      const rows = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.conceptUuid, result.uuid));
      expect(rows).toHaveLength(3);
      const kinds = rows.map((r) => r.kind).sort();
      expect(kinds).toEqual(['commit', 'mcp_write', 'repo_file']);
    });

    it('creates concept with no contributors (empty array)', async () => {
      const path = `svc-no-ctb-${randomUUID()}`;
      const result = await createConcept(
        db,
        validInput({
          path,
          contributors: [],
        }),
      );

      expect(result.contributorCount).toBe(0);
      const rows = await db
        .select()
        .from(schema.conceptContributors)
        .where(eq(schema.conceptContributors.conceptUuid, result.uuid));
      expect(rows).toHaveLength(0);
    });

    it('creates concept with no contributors (undefined)', async () => {
      const path = `svc-undef-ctb-${randomUUID()}`;
      const input = validInput({ path, contributors: undefined });

      const result = await createConcept(db, input);
      expect(result.contributorCount).toBe(0);
    });
  });

  // ── Failure: empty evidence ────────────────────────────────────────────

  describe('empty evidence rejection', () => {
    it('throws InvalidConceptError when evidence array is empty', async () => {
      const path = `svc-no-ev-${randomUUID()}`;
      await expect(
        createConcept(
          db,
          validInput({
            path,
            evidence: [],
          }),
        ),
      ).rejects.toThrow(InvalidConceptError);
    });

    it('does not create any rows when evidence is empty (transaction rollback)', async () => {
      const path = `svc-rollback-${randomUUID()}`;
      try {
        await createConcept(
          db,
          validInput({ path, evidence: [] }),
        );
      } catch {
        // Expected.
      }

      // Verify nothing was persisted.
      const paths = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.path, path));
      expect(paths).toHaveLength(0);
    });
  });

  // ── Failure: invalid path syntax ──────────────────────────────────────

  describe('invalid path syntax', () => {
    it('rejects uppercase characters per conceptPath contract (N5)', async () => {
      await expect(
        createConcept(db, validInput({ path: 'Services/API' })),
      ).rejects.toThrow(InvalidConceptError);
    });

    it('rejects a leading slash', async () => {
      await expect(
        createConcept(db, validInput({ path: '/services/api' })),
      ).rejects.toThrow(InvalidConceptError);
    });

    it('rejects .md suffix', async () => {
      await expect(
        createConcept(db, validInput({ path: 'services/api.md' })),
      ).rejects.toThrow(InvalidConceptError);
    });

    it('rejects empty path segments (double slash)', async () => {
      await expect(
        createConcept(db, validInput({ path: 'services//api' })),
      ).rejects.toThrow(InvalidConceptError);
    });
  });

  // ── Failure: repo_file evidence missing immutable fields ──────────────

  describe('repo_file evidence validation', () => {
    it('rejects repo_file evidence without repo field', async () => {
      await expect(
        createConcept(
          db,
          validInput({
            evidence: [
              {
                kind: 'repo_file',
                commitSha: 'abc1234',
                path: 'src/index.ts',
                at: new Date('2025-01-01T00:00:00.000Z'),
              } as never,
            ],
          }),
        ),
      ).rejects.toThrow(InvalidConceptError);
    });

    it('rejects repo_file evidence without commitSha field', async () => {
      await expect(
        createConcept(
          db,
          validInput({
            evidence: [
              {
                kind: 'repo_file',
                repo: 'teamem-ai/teamem',
                path: 'src/index.ts',
                at: new Date('2025-01-01T00:00:00.000Z'),
              } as never,
            ],
          }),
        ),
      ).rejects.toThrow(InvalidConceptError);
    });

    it('rejects repo_file evidence without path field', async () => {
      await expect(
        createConcept(
          db,
          validInput({
            evidence: [
              {
                kind: 'repo_file',
                repo: 'teamem-ai/teamem',
                commitSha: 'abc1234',
                at: new Date('2025-01-01T00:00:00.000Z'),
              } as never,
            ],
          }),
        ),
      ).rejects.toThrow(InvalidConceptError);
    });

    it('rejects repo_file evidence with invalid commitSha format', async () => {
      await expect(
        createConcept(
          db,
          validInput({
            evidence: [
              {
                kind: 'repo_file',
                repo: 'teamem-ai/teamem',
                commitSha: 'xyz',
                path: 'src/index.ts',
                at: new Date('2025-01-01T00:00:00.000Z'),
              } as never,
            ],
          }),
        ),
      ).rejects.toThrow(InvalidConceptError);
    });
  });

  // ── Failure: duplicate path ────────────────────────────────────────────

  describe('duplicate path rejection', () => {
    it('rejects a second concept with the same path (namespace uniqueness)', async () => {
      const path = `svc-dup-${randomUUID()}`;

      // First concept with this path — succeeds.
      const first = await createConcept(db, validInput({ path }));

      // Second concept with the same path — must fail.
      await expect(
        createConcept(db, validInput({ path })),
      ).rejects.toThrow();

      // Verify only the first concept exists.
      const paths = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.path, path));
      expect(paths).toHaveLength(1);
      expect(paths[0]!.conceptUuid).toBe(first.uuid);
    });
  });

  // ── client_claimed actors excluded from contributors ────────────────────

  describe('client_claimed actor exclusion', () => {
    it('does not insert a client_claimed principal as a contributor', async () => {
      const path = `svc-claimed-${randomUUID()}`;
      const result = await createConcept(
        db,
        validInput({
          path,
          contributors: [
            { principalId: 'pri_cw_alice', provenance: 'credential_bound' },
            { principalId: 'pri_cw_bob', provenance: 'client_claimed' },   // ← must be excluded
            { principalId: 'pri_cw_eve', provenance: 'unknown' },           // ← must be excluded
          ],
        }),
      );

      // Only Alice should be recorded.
      expect(result.contributorCount).toBe(1);

      const rows = await db
        .select()
        .from(schema.conceptContributors)
        .where(eq(schema.conceptContributors.conceptUuid, result.uuid));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.principalId).toBe('pri_cw_alice');
    });

    it('does not insert any contributor when all have client_claimed provenance', async () => {
      const path = `svc-all-claimed-${randomUUID()}`;
      const result = await createConcept(
        db,
        validInput({
          path,
          contributors: [
            { principalId: 'pri_cw_alice', provenance: 'client_claimed' },
            { principalId: 'pri_cw_bob', provenance: 'unknown' },
          ],
        }),
      );

      expect(result.contributorCount).toBe(0);
      const rows = await db
        .select()
        .from(schema.conceptContributors)
        .where(eq(schema.conceptContributors.conceptUuid, result.uuid));
      expect(rows).toHaveLength(0);
    });
  });

  // ── Cross-tenant isolation ─────────────────────────────────────────────

  describe('cross-tenant isolation', () => {
    it('rejects a contributor principal from a different team (FK violation)', async () => {
      const path = `svc-xteam-${randomUUID()}`;
      await expect(
        createConcept(
          db,
          validInput({
            path,
            contributors: [
              { principalId: 'pri_cw_other', provenance: 'credential_bound' },
            ],
          }),
        ),
      ).rejects.toThrow();

      // Verify nothing was persisted.
      const paths = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.path, path));
      expect(paths).toHaveLength(0);
    });
  });

  // ── Transaction atomicity ──────────────────────────────────────────────

  describe('transaction atomicity', () => {
    it('rolls back concept + evidence when path insert fails (duplicate path)', async () => {
      const path = `svc-atomic-${randomUUID()}`;

      // Create first concept successfully.
      const first = await createConcept(db, validInput({ path }));

      // Attempt duplicate — must fail.
      await expect(
        createConcept(db, validInput({ path })),
      ).rejects.toThrow();

      // Verify no orphan evidence, paths, or new concepts from the failed attempt.
      const allConcepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, testTeam));
      expect(allConcepts).toHaveLength(1);
      expect(allConcepts[0]!.uuid).toBe(first.uuid);

      const allPaths = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.conceptUuid, first.uuid));
      expect(allPaths).toHaveLength(1);

      const allEvidence = await db
        .select()
        .from(schema.conceptEvidence)
        .where(eq(schema.conceptEvidence.teamId, testTeam));
      expect(allEvidence).toHaveLength(1);
    });
  });

  // ── Embedding persistence (M1-EMB-04) ──────────────────────────────────

  describe('embedding persistence', () => {
    it('CLI step 1: vector mode — writes embedding and verifies 1536 dimensions', async () => {
      const path = `svc-emb-vec-${randomUUID()}`;
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      const result = await createConcept(
        db,
        validInput({ path, embedding }),
      );

      expect(result.uuid).toBeTruthy();

      // Verify the concept row was persisted with the embedding.
      const rows = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, result.uuid));
      expect(rows).toHaveLength(1);

      const concept = rows[0]!;
      // embedding must be non-null.
      expect(concept.embedding).not.toBeNull();
      // The vector should have 1536 dimensions.
      expect(concept.embedding).toHaveLength(1536);
      // All elements should be numbers, and sample values should roundtrip
      // (with minor float precision changes from JSON serialization).
      const emb = concept.embedding!;
      for (let i = 0; i < 1536; i++) {
        expect(typeof emb[i]).toBe('number');
      }
      expect(emb[0]!).toBeCloseTo(embedding[0]!, 5);
      expect(emb[1]!).toBeCloseTo(embedding[1]!, 5);

      // Other first-class columns are intact.
      expect(concept.title).toBe('Test Service');
      expect(concept.body).toBe('A test concept page.');
      expect(concept.type).toBe('service');
      expect(concept.status).toBe('active');
      expect(concept.confidence).toBe('high');
    });

    it('CLI step 2: fts-only mode — leaves embedding null, all other columns intact', async () => {
      const path = `svc-emb-fts-${randomUUID()}`;

      // No embedding field passed → fts-only degradation.
      const result = await createConcept(
        db,
        validInput({ path }),
      );

      expect(result.uuid).toBeTruthy();

      const rows = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, result.uuid));
      expect(rows).toHaveLength(1);

      const concept = rows[0]!;
      // embedding must be null — legal fts-only state.
      expect(concept.embedding).toBeNull();

      // All other first-class columns are intact (red line: embedding is
      // additive; it does not degrade any existing column).
      expect(concept.title).toBe('Test Service');
      expect(concept.body).toBe('A test concept page.');
      expect(concept.type).toBe('service');
      expect(concept.status).toBe('active');
      expect(concept.confidence).toBe('high');
      expect(concept.tags).toEqual(['test', 'example']);
      expect(concept.firstSeen).toBeTruthy();
      expect(concept.lastConfirmed).toBeTruthy();
    });

    it('explicit null embedding leaves column null (same as fts-only)', async () => {
      const path = `svc-emb-null-${randomUUID()}`;

      const result = await createConcept(
        db,
        validInput({ path, embedding: null }),
      );

      expect(result.uuid).toBeTruthy();

      const rows = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, result.uuid));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.embedding).toBeNull();
    });

    it('CLI step 3: embedding write with invalid evidence still fails (no partial data)', async () => {
      // Embedding is provided but evidence is empty → the entire write
      // must fail BEFORE any database work, including the embedding write.
      const path = `svc-emb-rollback-${randomUUID()}`;
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      await expect(
        createConcept(
          db,
          validInput({ path, embedding, evidence: [] }),
        ),
      ).rejects.toThrow(InvalidConceptError);

      // Verify nothing was persisted — no concept, no path, no embedding.
      // The evidence-is-empty check throws before any database work starts,
      // so the path must not exist.
      const paths = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.path, path));
      expect(paths).toHaveLength(0);
    });

    it('CLI step 3-bis: DB-level rollback — duplicate path with embedding leaves no orphan data', async () => {
      // This exercises a real DB-level rollback (inside the transaction),
      // not the pre-transaction validation guards.  The first write
      // succeeds; the second fails on the unique path constraint.  The
      // second attempt's embedding and evidence must not leak into the DB.
      const path = `svc-emb-dbrollback-${randomUUID()}`;
      const embedding1 = Array.from({ length: 1536 }, () => 0.1);
      const embedding2 = Array.from({ length: 1536 }, () => 0.9);

      // First concept with embedding — succeeds.
      const first = await createConcept(
        db,
        validInput({ path, embedding: embedding1 }),
      );
      expect(first.uuid).toBeTruthy();

      // Second concept — same path, different embedding — must fail.
      await expect(
        createConcept(
          db,
          validInput({ path, embedding: embedding2 }),
        ),
      ).rejects.toThrow();

      // Only the first concept exists.
      const allConcepts = await db
        .select()
        .from(schema.concepts)
        .where(eq(schema.concepts.teamId, testTeam));
      expect(allConcepts).toHaveLength(1);
      expect(allConcepts[0]!.uuid).toBe(first.uuid);

      // The first concept's embedding is still intact (embedding2 was never persisted).
      const concept = await db
        .select({ embedding: schema.concepts.embedding })
        .from(schema.concepts)
        .where(eq(schema.concepts.uuid, first.uuid));
      expect(concept).toHaveLength(1);
      expect(concept[0]!.embedding).not.toBeNull();
      expect(concept[0]!.embedding).toHaveLength(1536);
      // First value should be ~0.1, not ~0.9 (proving embedding2 was rolled back).
      expect(concept[0]!.embedding![0]!).toBeCloseTo(0.1, 1);

      // Only one path exists.
      const paths = await db
        .select()
        .from(schema.conceptPaths)
        .where(eq(schema.conceptPaths.path, path));
      expect(paths).toHaveLength(1);
      expect(paths[0]!.conceptUuid).toBe(first.uuid);
    });
  });
});
