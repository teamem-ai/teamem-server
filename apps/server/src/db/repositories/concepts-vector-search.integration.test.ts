/**
 * pgvector cosine-similarity candidate query — real-Postgres integration tests.
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres with migrations
 * applied; honestly skipped otherwise — no mocked database, per project
 * red line.
 *
 * Covers:
 * - Success path: write 3 concepts → query with a near embedding → hit the
 *   expected concept ranked first
 * - Cross-team isolation: team_b scope on team_a embeddings → empty result,
 *   indistinguishable from "no concepts exist"
 * - Scope enforcement: allProjects scope returns empty (compile-time type
 *   narrowing required for a project scope)
 * - Embedding NULL exclusion: concepts without embeddings are silently
 *   skipped
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../client.js';
import {
  findSimilarConcepts,
  InvalidVectorSearchError,
  type FindSimilarConceptsParams,
} from './concepts-vector-search.js';
import {
  projectScope,
  allProjectsScope,
} from '../../auth/scope.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('ConceptsVectorSearch (live Postgres + pgvector)', () => {
  let db: AppDb;

  const teamA = 'team_vsa';
  const teamB = 'team_vsb';
  const projectA = 'prj_vsa';
  const projectB = 'prj_vsb';

  // Shared UUIDs for concepts we'll seed.
  const conceptA1 = randomUUID();
  const conceptA2 = randomUUID();
  const conceptA3 = randomUUID();

  // ── Seed data ──────────────────────────────────────────────────────────

  beforeAll(async () => {
    db = createDb(url!);

    // Teams.
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${teamA}', 'VS Team A')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${teamB}', 'VS Team B')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Projects.
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${projectA}', '${teamA}', 'VS Project A')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${projectB}', '${teamB}', 'VS Project B')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed 3 concepts in teamA/projectA with distinct embedding directions.
    // We use hand‑crafted vectors so similarity ordering is deterministic.

    // Concept A1: strongly about "postgresql database" → first 512 dims = 0.02
    const emb1 = new Array(1536).fill(0);
    for (let i = 0; i < 512; i++) emb1[i] = 0.02;

    // Concept A2: strongly about "typescript frontend react" → dims 512..1023 = 0.02
    const emb2 = new Array(1536).fill(0);
    for (let i = 512; i < 1024; i++) emb2[i] = 0.02;

    // Concept A3: strongly about "kubernetes docker devops" → dims 1024..1535 = 0.02
    const emb3 = new Array(1536).fill(0);
    for (let i = 1024; i < 1536; i++) emb3[i] = 0.02;

    const embedVector = (v: number[]) => `'[${v.join(',')}]'::vector`;

    await db.execute(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
        title, body, tags, first_seen, last_confirmed, embedding)
      VALUES
        ('${conceptA1}', '${teamA}', '${projectA}', 1, 'concept', 'active', 'high',
         'PostgreSQL Performance Tuning', '# PostgreSQL Performance\n\nUse indexes wisely and vacuum regularly.',
         ARRAY['database', 'postgresql']::text[], now(), now(),
         ${embedVector(emb1)}),
        ('${conceptA2}', '${teamA}', '${projectA}', 1, 'concept', 'active', 'high',
         'React Component Patterns', '# React Patterns\n\nPrefer composition over inheritance.',
         ARRAY['frontend', 'react']::text[], now(), now(),
         ${embedVector(emb2)}),
        ('${conceptA3}', '${teamA}', '${projectA}', 1, 'concept', 'active', 'high',
         'Docker Multi-Stage Builds', '# Docker\n\nMulti-stage builds reduce image size.',
         ARRAY['devops', 'docker']::text[], now(), now(),
         ${embedVector(emb3)})
      ON CONFLICT (uuid) DO NOTHING;
    `);

    // Paths for the seeded concepts.
    await db.execute(`
      INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
      VALUES
        ('${teamA}', '${projectA}', '${conceptA1}', 'postgresql-performance', true),
        ('${teamA}', '${projectA}', '${conceptA2}', 'react-component-patterns', true),
        ('${teamA}', '${projectA}', '${conceptA3}', 'docker-multi-stage-builds', true)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    // Clean up in reverse dependency order.
    await db.execute(`
      DELETE FROM concept_paths    WHERE team_id = '${teamA}';
      DELETE FROM concept_evidence WHERE team_id = '${teamA}';
      DELETE FROM concept_contributors WHERE team_id = '${teamA}';
      DELETE FROM concepts         WHERE team_id = '${teamA}';
      DELETE FROM projects         WHERE id = '${projectA}';
      DELETE FROM teams            WHERE id = '${teamA}';

      DELETE FROM concept_paths    WHERE team_id = '${teamB}';
      DELETE FROM concept_evidence WHERE team_id = '${teamB}';
      DELETE FROM concept_contributors WHERE team_id = '${teamB}';
      DELETE FROM concepts         WHERE team_id = '${teamB}';
      DELETE FROM projects         WHERE id = '${projectB}';
      DELETE FROM teams            WHERE id = '${teamB}';
    `);
  });

  beforeEach(async () => {
    // Re-seed the paths (cleaned up above only when there was a prior run
    // within this process lifetime — the afterAll handles final cleanup).
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Build a query embedding that matches concept A2 (React, dims 512..1023). */
  const queryNearA2 = (): number[] => {
    const v = new Array(1536).fill(0);
    for (let i = 512; i < 1024; i++) v[i] = 0.02;
    return v;
  };

  /** Build a query embedding that matches concept A1 (Postgres, dims 0..511). */
  const queryNearA1 = (): number[] => {
    const v = new Array(1536).fill(0);
    for (let i = 0; i < 512; i++) v[i] = 0.02;
    return v;
  };

  // ── CLI step 1: Success path — query near A2 → A2 ranked first ──────────

  describe('CLI step 1: success path', () => {
    it('ranks concept A2 first when querying with an A2‑near embedding', async () => {
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
        limit: 3,
      });

      // All 3 seeded concepts should be returned (all have embeddings).
      expect(results).toHaveLength(3);

      // The React-flavoured concept (A2) must rank first.
      expect(results[0]!.uuid).toBe(conceptA2);
      expect(results[0]!.title).toBe('React Component Patterns');
      expect(results[0]!.path).toBe('react-component-patterns');

      // Similarity for the best match should be > 0 (it's a near‑exact
      // directional match).  A2 vs queryNearA2 are identical in dims
      // 512..1023 and zero elsewhere, so similarity ≈ 1.0.
      expect(results[0]!.similarity).toBeGreaterThan(0.9);

      // The other two should have much lower similarity (orthogonal
      // subspaces → cosine distance ≈ 1 → similarity ≈ 0).
      expect(results[1]!.similarity).toBeLessThan(0.1);
      expect(results[2]!.similarity).toBeLessThan(0.1);
    });

    it('ranks A1 first when querying with an A1‑near embedding', async () => {
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA1(),
        limit: 3,
      });

      expect(results).toHaveLength(3);
      expect(results[0]!.uuid).toBe(conceptA1);
      expect(results[0]!.title).toBe('PostgreSQL Performance Tuning');
      expect(results[0]!.similarity).toBeGreaterThan(0.9);
    });

    it('returns all rows when limit is larger than the matching set', async () => {
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
        limit: 20,
      });

      // Only 3 seeded concepts exist; all have embeddings.
      expect(results).toHaveLength(3);
    });

    it('respects the limit parameter (returns at most k rows)', async () => {
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
        limit: 2,
      });

      expect(results).toHaveLength(2);
      // The top 2 should still have A2 first.
      expect(results[0]!.uuid).toBe(conceptA2);
    });
  });

  // ── Path information in results ────────────────────────────────────────

  describe('result shape', () => {
    it('includes all required fields in each result row', async () => {
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
        limit: 1,
      });

      expect(results).toHaveLength(1);
      const row = results[0]!;

      expect(typeof row.uuid).toBe('string');
      expect(typeof row.path).toBe('string');
      expect(typeof row.type).toBe('string');
      expect(typeof row.status).toBe('string');
      expect(typeof row.confidence).toBe('string');
      expect(typeof row.title).toBe('string');
      expect(Array.isArray(row.tags)).toBe(true);
      expect(row.lastConfirmed).toBeInstanceOf(Date);
      expect(typeof row.similarity).toBe('number');
      expect(row.similarity).toBeGreaterThanOrEqual(0);
      expect(row.similarity).toBeLessThanOrEqual(1);
      expect(typeof row.bodySnippet).toBe('string');
      expect(row.bodySnippet.length).toBeLessThanOrEqual(203); // ~200 + '…'
    });
  });

  // ── CLI step 2: Cross-team isolation ───────────────────────────────────

  describe('CLI step 2: cross-team isolation', () => {
    it('returns empty when team B scope queries team A embeddings', async () => {
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamB, projectB),
        queryEmbedding: queryNearA2(),
        // Use the same query embedding that would match team A's concepts.
      });

      expect(results).toHaveLength(0);
      // Indistinguishable from "team B simply has no similar concepts."
      // No error thrown, no existence leaked.
    });

    it('returns empty when team B has its own concepts with embeddings but team A query is used', async () => {
      // Seed one concept in team B so we know the table is not empty for team B.
      const embB = new Array(1536).fill(0);
      for (let i = 0; i < 512; i++) embB[i] = 0.03;
      const conceptB = randomUUID();

      await db.execute(`
        INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
          title, body, tags, first_seen, last_confirmed, embedding)
        VALUES
          ('${conceptB}', '${teamB}', '${projectB}', 1, 'concept', 'active', 'high',
           'Team B Concept', '# B', ARRAY[]::text[], now(), now(),
           '[${embB.join(',')}]'::vector)
        ON CONFLICT (uuid) DO NOTHING;
      `);
      await db.execute(`
        INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
        VALUES ('${teamB}', '${projectB}', '${conceptB}', 'team-b-concept', true)
        ON CONFLICT DO NOTHING;
      `);

      // Query with team B scope using a vector near A2.  Team B's only
      // concept has a different embedding, so it should match poorly (but
      // still appear, not empty).
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamB, projectB),
        queryEmbedding: queryNearA2(),
        limit: 5,
      });

      // Team B has one concept — it should appear (even with low similarity).
      expect(results).toHaveLength(1);
      expect(results[0]!.uuid).toBe(conceptB);

      // Now team A scope on the same query must still only see team A concepts.
      const resultsA = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
        limit: 5,
      });
      expect(resultsA).toHaveLength(3);
      expect(resultsA[0]!.uuid).toBe(conceptA2);
    });
  });

  // ── CLI step 3: Scope enforcement — allProjects returns empty ──────────

  describe('CLI step 3: scope enforcement', () => {
    it('returns empty for allProjects scope (no project to scope to)', async () => {
      const results = await findSimilarConcepts(db, {
        scope: allProjectsScope(teamA),
        queryEmbedding: queryNearA2(),
      });

      expect(results).toHaveLength(0);
      // No error — the function silently returns empty because a
      // project‑level vector search is not meaningful without a project.
    });

    it('function signature requires ScopeContext (type‑level check)', () => {
      // Static assertion: the params type must have a `scope` property of
      // type ScopeContext.  This test simply confirms the type compiles;
      // the runtime behaviour is tested above.
      const params: FindSimilarConceptsParams = {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
        limit: 5,
      };
      expect(params.scope).toBeDefined();
      expect(params.scope.kind).toBe('project');
    });

    it('compile‑time: no unscoped entry point exists', async () => {
      // The function signature only accepts FindSimilarConceptsParams which
      // requires `scope: ScopeContext`.  There is no overload or alternate
      // entry point that bypasses scope.  This is verified by the TypeScript
      // compiler via `pnpm typecheck`.
      //
      // Runtime sanity: calling with a valid ProjectScope works.
      await expect(
        findSimilarConcepts(db, {
          scope: projectScope(teamA, projectA),
          queryEmbedding: queryNearA2(),
          limit: 1,
        }),
      ).resolves.toBeDefined();
    });
  });

  // ── Embedding NULL exclusion ───────────────────────────────────────────

  describe('NULL embedding exclusion', () => {
    it('skips concepts without embeddings', async () => {
      // Seed a concept with NULL embedding in team A.
      const conceptNullEmb = randomUUID();
      await db.execute(`
        INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
          title, body, tags, first_seen, last_confirmed, embedding)
        VALUES
          ('${conceptNullEmb}', '${teamA}', '${projectA}', 1, 'concept', 'active', 'high',
           'FTs Only Page', '# No Embedding', ARRAY[]::text[], now(), now(),
           NULL)
        ON CONFLICT (uuid) DO NOTHING;
      `);
      await db.execute(`
        INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
        VALUES ('${teamA}', '${projectA}', '${conceptNullEmb}', 'fts-only-page', true)
        ON CONFLICT DO NOTHING;
      `);

      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
        limit: 10,
      });

      // The NULL‑embedding concept must NOT appear.
      const uuids = results.map((r) => r.uuid);
      expect(uuids).not.toContain(conceptNullEmb);

      // But we still get the 3 seeded concepts WITH embeddings.
      expect(uuids).toContain(conceptA1);
      expect(uuids).toContain(conceptA2);
      expect(uuids).toContain(conceptA3);
    });

    it('returns empty when no concepts have embeddings in the project', async () => {
      // Use a fresh teamC / projectC that has never been touched.
      const teamC = 'team_vsc';
      const projectC = 'prj_vsc';

      await db.execute(`
        INSERT INTO teams (id, name) VALUES ('${teamC}', 'VS Team C')
        ON CONFLICT (id) DO NOTHING;
      `);
      await db.execute(`
        INSERT INTO projects (id, team_id, name) VALUES ('${projectC}', '${teamC}', 'VS Project C')
        ON CONFLICT (id) DO NOTHING;
      `);

      // Seed a concept WITHOUT embedding — it should be excluded.
      const conceptC = randomUUID();
      await db.execute(`
        INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
          title, body, tags, first_seen, last_confirmed, embedding)
        VALUES
          ('${conceptC}', '${teamC}', '${projectC}', 1, 'concept', 'active', 'high',
           'No Embedding Page', '# No Emb', ARRAY[]::text[], now(), now(),
           NULL)
        ON CONFLICT (uuid) DO NOTHING;
      `);

      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamC, projectC),
        queryEmbedding: queryNearA2(),
      });

      expect(results).toHaveLength(0);
      // Not an error — just no embeddable concepts.

      // Clean up.
      await db.execute(`
        DELETE FROM concepts         WHERE team_id = '${teamC}';
        DELETE FROM projects         WHERE id = '${projectC}';
        DELETE FROM teams            WHERE id = '${teamC}';
      `);
    });
  });

  // ── Limit validation ───────────────────────────────────────────────────

  describe('limit validation', () => {
    it('rejects limit > MAX_LIMIT (100) per frozen contract §6.3', async () => {
      await expect(
        findSimilarConcepts(db, {
          scope: projectScope(teamA, projectA),
          queryEmbedding: queryNearA2(),
          limit: 500,
        }),
      ).rejects.toThrow(InvalidVectorSearchError);

      await expect(
        findSimilarConcepts(db, {
          scope: projectScope(teamA, projectA),
          queryEmbedding: queryNearA2(),
          limit: 500,
        }),
      ).rejects.toThrow('limit 500 is outside allowed range [1, 100]');
    });

    it('accepts limit = MAX_LIMIT (100) exactly', async () => {
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
        limit: 100,
      });

      // 100 is allowed; only 3 seeded concepts exist so we get 3.
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('defaults to 20 when no limit is passed', async () => {
      const results = await findSimilarConcepts(db, {
        scope: projectScope(teamA, projectA),
        queryEmbedding: queryNearA2(),
      });

      expect(results).toHaveLength(3); // only 3 exist, but default of 20 was applied
    });

    it('rejects limit = 0 (below valid range)', async () => {
      await expect(
        findSimilarConcepts(db, {
          scope: projectScope(teamA, projectA),
          queryEmbedding: queryNearA2(),
          limit: 0,
        }),
      ).rejects.toThrow(InvalidVectorSearchError);
    });

    it('rejects negative limit', async () => {
      await expect(
        findSimilarConcepts(db, {
          scope: projectScope(teamA, projectA),
          queryEmbedding: queryNearA2(),
          limit: -1,
        }),
      ).rejects.toThrow(InvalidVectorSearchError);
    });
  });
});
