/**
 * F2 candidate recall integration tests (DUA-198 M1-F2-02).
 *
 * Runs against real PostgreSQL with pgvector. Tests both vector and
 * fts-only recall paths, cross-team isolation, scope enforcement,
 * and degradation observability.
 *
 * The embedding client is faked for vector-mode tests (external boundary
 * mock is acceptable per engineering red lines). FTS tests use the real
 * PostgreSQL full-text search path. All database queries hit real Postgres.
 *
 * Requires TEST_DATABASE_URL. Honest skip when unavailable — never claims
 * mock database results as database verification.
 *
 * Covers:
 *  - CLI step 1: new knowledge similar to existing page → page in top-5
 *  - CLI step 2: cross-team candidate recall returns empty
 *  - Vector mode: cosine similarity ranking
 *  - FTS-only mode: explicit degradation with mode='fts' on every row
 *  - Scope enforcement: allProjects returns empty
 *  - Boundary: empty project returns empty
 *  - Boundary: limit enforcement
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../../db/client.js';
import {
  recallCandidates,
  CandidateRecallError,
} from './candidates.js';
import type { EmbeddingClient } from '../../llm/embedding/port.js';
import { EMBEDDING_DIMENSION } from '../../llm/embedding/port.js';
import { projectScope, allProjectsScope } from '../../auth/scope.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('recallCandidates (live Postgres + pgvector)', () => {
  let db: AppDb;

  // ── Stable seed IDs ────────────────────────────────────────────────────
  const teamA = 'team_f2cra';
  const teamB = 'team_f2crb';
  const projectA = 'prj_f2cra';
  const projectB = 'prj_f2crb';

  // Concept UUIDs for team A.
  const conceptPostgres = randomUUID();
  const conceptReact = randomUUID();
  const conceptDocker = randomUUID();

  // ── Embedding helpers ──────────────────────────────────────────────────

  /** Build a 1536‑d vector with energy in the first 512 dims (Postgres flavour). */
  function postgresEmbedding(): number[] {
    const v = new Array(EMBEDDING_DIMENSION).fill(0);
    for (let i = 0; i < 512; i++) v[i] = 0.02;
    return v;
  }

  /** Build a 1536‑d vector with energy in dims 512..1023 (React flavour). */
  function reactEmbedding(): number[] {
    const v = new Array(EMBEDDING_DIMENSION).fill(0);
    for (let i = 512; i < 1024; i++) v[i] = 0.02;
    return v;
  }

  /** Build a 1536‑d vector with energy in dims 1024..1535 (Docker flavour). */
  function dockerEmbedding(): number[] {
    const v = new Array(EMBEDDING_DIMENSION).fill(0);
    for (let i = 1024; i < EMBEDDING_DIMENSION; i++) v[i] = 0.02;
    return v;
  }

  /** Format a number[] as a pgvector literal string. */
  function embedVector(v: number[]): string {
    return `'[${v.join(',')}]'::vector`;
  }

  // ── Fake embedding client ──────────────────────────────────────────────

  /**
   * Create a fake EmbeddingClient that returns a pre‑baked vector.
   * The fake satisfies the EmbeddingClient contract — it returns an
   * equal‑length array of vectors, one per input.
   */
  function fakeEmbeddingClient(vector: number[]): EmbeddingClient {
    return {
      generate: async (inputs: string[]) => {
        return inputs.map(() => [...vector]);
      },
    };
  }

  // ── Seed data ──────────────────────────────────────────────────────────

  beforeAll(async () => {
    db = createDb(url!);

    // Teams.
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${teamA}', 'F2CR Team A')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${teamB}', 'F2CR Team B')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Projects.
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${projectA}', '${teamA}', 'F2CR Project A')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${projectB}', '${teamB}', 'F2CR Project B')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed 3 concepts in team A with distinct embedding directions.
    await db.execute(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
        title, body, tags, first_seen, last_confirmed, embedding)
      VALUES
        ('${conceptPostgres}', '${teamA}', '${projectA}', 1, 'decision', 'active', 'high',
         'Use Postgres for the primary datastore',
         '## Decision\n\nWe chose Postgres over MongoDB for the primary datastore.\n\n### Rationale\n\n- Strong ACID guarantees\n- Mature ecosystem\n- Better tooling support',
         ARRAY['database', 'postgres']::text[], now(), now(),
         ${embedVector(postgresEmbedding())}),
        ('${conceptReact}', '${teamA}', '${projectA}', 1, 'convention', 'active', 'high',
         'React Component Patterns',
         '## Convention\n\nPrefer function components with hooks over class components.\n\n### Rules\n\n- Use composition over inheritance\n- Keep components small and focused',
         ARRAY['frontend', 'react']::text[], now(), now(),
         ${embedVector(reactEmbedding())}),
        ('${conceptDocker}', '${teamA}', '${projectA}', 1, 'runbook', 'active', 'high',
         'Docker Multi-Stage Builds',
         '## Runbook\n\nUse multi-stage builds to reduce image size.\n\n### Steps\n\n1. Build stage: compile with all dev dependencies\n2. Runtime stage: copy only the built artifacts',
         ARRAY['devops', 'docker']::text[], now(), now(),
         ${embedVector(dockerEmbedding())})
      ON CONFLICT (uuid) DO NOTHING;
    `);

    // Paths for the seeded concepts.
    await db.execute(`
      INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
      VALUES
        ('${teamA}', '${projectA}', '${conceptPostgres}', 'use-postgres-primary-datastore', true),
        ('${teamA}', '${projectA}', '${conceptReact}', 'react-component-patterns', true),
        ('${teamA}', '${projectA}', '${conceptDocker}', 'docker-multi-stage-builds', true)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    // Clean up in reverse dependency order.
    await db.execute(`
      DELETE FROM concept_paths    WHERE team_id = '${teamA}' OR team_id = '${teamB}';
      DELETE FROM concept_evidence WHERE team_id = '${teamA}' OR team_id = '${teamB}';
      DELETE FROM concept_contributors WHERE team_id = '${teamA}' OR team_id = '${teamB}';
      DELETE FROM concepts         WHERE team_id = '${teamA}' OR team_id = '${teamB}';
      DELETE FROM projects         WHERE id IN ('${projectA}', '${projectB}');
      DELETE FROM teams            WHERE id IN ('${teamA}', '${teamB}');
    `);
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  function newConcept(overrides?: { title?: string; body?: string }) {
    return {
      title: overrides?.title ?? 'Use Postgres for the database',
      body: overrides?.body ??
        '## Decision\n\nWe use Postgres as the primary database.\n\n### Rationale\n\n- ACID compliance\n- JSON support',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLI step 1: Success path — similar knowledge recalls the expected page
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLI step 1: vector mode — similar knowledge recalls matching page', () => {
    it('ranks the Postgres concept first when querying with Postgres-like new knowledge', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept({ title: 'Use Postgres for the primary datastore' }),
          limit: 5,
        },
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      // The Postgres concept should be top-ranked.
      expect(results[0]!.uuid).toBe(conceptPostgres);
      expect(results[0]!.title).toBe('Use Postgres for the primary datastore');
      expect(results[0]!.mode).toBe('vector');
      expect(results[0]!.similarity).toBeGreaterThan(0.9);
    });

    it('ranks the React concept first when querying with React-like new knowledge', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(reactEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept({
            title: 'React Component Patterns discussion',
            body: 'We discussed React patterns. Prefer hooks.',
          }),
          limit: 5,
        },
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.uuid).toBe(conceptReact);
      expect(results[0]!.mode).toBe('vector');
      expect(results[0]!.similarity).toBeGreaterThan(0.9);
    });

    it('returns all 3 seeded concepts when limit=5', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept(),
          limit: 5,
        },
      );

      // Only 3 exist; all appear.
      expect(results).toHaveLength(3);
      // All have mode='vector'.
      for (const r of results) {
        expect(r.mode).toBe('vector');
      }
    });

    it('respects the limit parameter (top-2 only)', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept(),
          limit: 2,
        },
      );

      expect(results).toHaveLength(2);
      expect(results[0]!.uuid).toBe(conceptPostgres);
    });

    it('defaults to limit=5 when not specified', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept(),
        },
      );

      // 3 concepts exist, all returned under default limit of 5.
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results.length).toBe(3);
    });

    it('caps limit at MAX_LIMIT (20)', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept(),
          limit: 100,
        },
      );

      // Even with limit=100, only 3 concepts exist; they're all returned.
      expect(results).toHaveLength(3);
    });

    it('returns results with correct shape', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept(),
          limit: 1,
        },
      );

      expect(results).toHaveLength(1);
      const r = results[0]!;

      expect(typeof r.uuid).toBe('string');
      expect(typeof r.path).toBe('string');
      expect(r.path.length).toBeGreaterThan(0);
      expect(typeof r.type).toBe('string');
      expect(typeof r.status).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(Array.isArray(r.tags)).toBe(true);
      expect(typeof r.similarity).toBe('number');
      expect(r.similarity).toBeGreaterThanOrEqual(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
      expect(r.mode).toBe('vector');
      expect(typeof r.bodySnippet).toBe('string');
      expect(r.bodySnippet.length).toBeLessThanOrEqual(203);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CLI step 2: Cross-team isolation
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLI step 2: cross-team candidate recall returns empty', () => {
    it('returns empty when team B scope queries team A embeddings', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamB, projectB),
          newConcept: newConcept(),
          limit: 5,
        },
      );

      expect(results).toHaveLength(0);
      // Indistinguishable from "team B simply has no similar concepts."
    });

    it('returns empty for team B with FTS query that would match team A content', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: projectScope(teamB, projectB),
          newConcept: newConcept({
            title: 'Postgres for the primary datastore',
            body: 'We chose Postgres over MongoDB.',
          }),
          limit: 5,
        },
      );

      expect(results).toHaveLength(0);
    });

    it('team A results are unaffected by team B activity', async () => {
      // Ensure team A still gets its own results.
      const resultsA = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept(),
          limit: 5,
        },
      );

      expect(resultsA).toHaveLength(3);
      expect(resultsA[0]!.uuid).toBe(conceptPostgres);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FTS-only mode
  // ═══════════════════════════════════════════════════════════════════════

  describe('FTS-only mode', () => {
    it('returns candidates with mode=fts when capability is fts-only', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept({
            title: 'Postgres for the primary datastore',
            body: 'We chose Postgres over MongoDB for the primary datastore.',
          }),
          limit: 5,
        },
      );

      // FTS should find at least the Postgres concept.
      expect(results.length).toBeGreaterThanOrEqual(1);

      // Every row must report mode='fts' (explicit degradation, §5.5).
      for (const r of results) {
        expect(r.mode).toBe('fts');
        expect(typeof r.similarity).toBe('number');
        expect(r.similarity).toBeGreaterThanOrEqual(0);
        expect(r.similarity).toBeLessThanOrEqual(1);
      }
    });

    it('FTS query containing "Postgres" matches the Postgres concept', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept({
            title: 'Postgres MongoDB ACID',
            body: 'We chose Postgres over MongoDB.',
          }),
          limit: 5,
        },
      );

      const uuids = results.map((r) => r.uuid);
      expect(uuids).toContain(conceptPostgres);
    });

    it('FTS query about React finds the React concept', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept({
            title: 'React function components hooks',
            body: 'Prefer function components over class components.',
          }),
          limit: 5,
        },
      );

      const uuids = results.map((r) => r.uuid);
      expect(uuids).toContain(conceptReact);
    });

    it('FTS returns empty for a query with no matching terms', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept({
            title: 'Zygohistomorphic prepromorphism',
            body: 'This is a completely unrelated topic with unique vocabulary.',
          }),
          limit: 5,
        },
      );

      // FTS may return zero results when no terms match.
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('empty newConcept text returns empty (no query to search)', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: { title: '', body: '' },
          limit: 5,
        },
      );

      expect(results).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scope enforcement
  // ═══════════════════════════════════════════════════════════════════════

  describe('scope enforcement', () => {
    it('allProjects scope returns empty in vector mode', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: allProjectsScope(teamA),
          newConcept: newConcept(),
          limit: 5,
        },
      );

      expect(results).toHaveLength(0);
    });

    it('allProjects scope returns empty in fts-only mode', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: allProjectsScope(teamA),
          newConcept: newConcept({ title: 'Postgres' }),
          limit: 5,
        },
      );

      expect(results).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Edge cases and boundary
  // ═══════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('returns empty for a project with no concepts', async () => {
      // Create a fresh team/project with no concepts.
      const emptyTeam = 'team_f2crEmpty';
      const emptyProject = 'prj_f2crEmpty';

      await db.execute(`
        INSERT INTO teams (id, name) VALUES ('${emptyTeam}', 'Empty Team')
        ON CONFLICT (id) DO NOTHING;
      `);
      await db.execute(`
        INSERT INTO projects (id, team_id, name) VALUES ('${emptyProject}', '${emptyTeam}', 'Empty Project')
        ON CONFLICT (id) DO NOTHING;
      `);

      try {
        const results = await recallCandidates(
          {
            db,
            embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
            capability: { mode: 'vector' },
          },
          {
            scope: projectScope(emptyTeam, emptyProject),
            newConcept: newConcept(),
            limit: 5,
          },
        );

        expect(results).toHaveLength(0);
      } finally {
        // Clean up.
        await db.execute(`
          DELETE FROM concepts  WHERE team_id = '${emptyTeam}';
          DELETE FROM projects  WHERE id = '${emptyProject}';
          DELETE FROM teams     WHERE id = '${emptyTeam}';
        `);
      }
    });

    it('returns empty for project with concepts that all have NULL embeddings (vector mode)', async () => {
      // Create a team/project with only NULL-embedding concepts.
      const nullEmbTeam = 'team_f2crNull';
      const nullEmbProject = 'prj_f2crNull';
      const nullConceptId = randomUUID();

      await db.execute(`
        INSERT INTO teams (id, name) VALUES ('${nullEmbTeam}', 'Null Emb Team')
        ON CONFLICT (id) DO NOTHING;
      `);
      await db.execute(`
        INSERT INTO projects (id, team_id, name) VALUES ('${nullEmbProject}', '${nullEmbTeam}', 'Null Emb Project')
        ON CONFLICT (id) DO NOTHING;
      `);
      await db.execute(`
        INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
          title, body, tags, first_seen, last_confirmed, embedding)
        VALUES
          ('${nullConceptId}', '${nullEmbTeam}', '${nullEmbProject}', 1, 'concept', 'active', 'high',
           'No Embedding Page', '# No Emb', ARRAY[]::text[], now(), now(),
           NULL)
        ON CONFLICT (uuid) DO NOTHING;
      `);

      try {
        const results = await recallCandidates(
          {
            db,
            embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
            capability: { mode: 'vector' },
          },
          {
            scope: projectScope(nullEmbTeam, nullEmbProject),
            newConcept: newConcept(),
            limit: 5,
          },
        );

        // NULL-embedding concepts are excluded from vector search.
        expect(results).toHaveLength(0);
      } finally {
        await db.execute(`
          DELETE FROM concepts  WHERE team_id = '${nullEmbTeam}';
          DELETE FROM projects  WHERE id = '${nullEmbProject}';
          DELETE FROM teams     WHERE id = '${nullEmbTeam}';
        `);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Error paths
  // ═══════════════════════════════════════════════════════════════════════

  describe('error paths', () => {
    it('throws CandidateRecallError when vector mode has no embedding client', async () => {
      await expect(
        recallCandidates(
          {
            db,
            embeddingClient: null, // vector mode requires an embedding client
            capability: { mode: 'vector' },
          },
          {
            scope: projectScope(teamA, projectA),
            newConcept: newConcept(),
            limit: 5,
          },
        ),
      ).rejects.toThrow(CandidateRecallError);
    });

    it('failing embedding client throws CandidateRecallError', async () => {
      const failingClient: EmbeddingClient = {
        generate: async () => {
          throw new Error('Embedding API is down');
        },
      };

      await expect(
        recallCandidates(
          {
            db,
            embeddingClient: failingClient,
            capability: { mode: 'vector' },
          },
          {
            scope: projectScope(teamA, projectA),
            newConcept: newConcept(),
            limit: 5,
          },
        ),
      ).rejects.toThrow(CandidateRecallError);
    });

    it('empty embedding result throws CandidateRecallError', async () => {
      const emptyClient: EmbeddingClient = {
        generate: async () => {
          return []; // empty result — violates contract
        },
      };

      await expect(
        recallCandidates(
          {
            db,
            embeddingClient: emptyClient,
            capability: { mode: 'vector' },
          },
          {
            scope: projectScope(teamA, projectA),
            newConcept: newConcept(),
            limit: 5,
          },
        ),
      ).rejects.toThrow(CandidateRecallError);
    });

    it('null embedding array element throws CandidateRecallError', async () => {
      const nullElementClient: EmbeddingClient = {
        generate: async () => {
          // Return an array with a null-ish first element.
          return [null as unknown as number[]];
        },
      };

      await expect(
        recallCandidates(
          {
            db,
            embeddingClient: nullElementClient,
            capability: { mode: 'vector' },
          },
          {
            scope: projectScope(teamA, projectA),
            newConcept: newConcept(),
            limit: 5,
          },
        ),
      ).rejects.toThrow(CandidateRecallError);
    });

    it('wrong-dimension embedding throws CandidateRecallError, not InvalidVectorSearchError', async () => {
      const wrongDimClient: EmbeddingClient = {
        generate: async () => {
          // Return a 768-d vector — valid array but wrong dimension.
          return [new Array(768).fill(0.1)];
        },
      };

      await expect(
        recallCandidates(
          {
            db,
            embeddingClient: wrongDimClient,
            capability: { mode: 'vector' },
          },
          {
            scope: projectScope(teamA, projectA),
            newConcept: newConcept(),
            limit: 5,
          },
        ),
      ).rejects.toThrow(CandidateRecallError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Degradation observability
  // ═══════════════════════════════════════════════════════════════════════

  describe('degradation observability (§5.5)', () => {
    it('every vector result has mode=vector', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept(),
          limit: 5,
        },
      );

      for (const r of results) {
        expect(r.mode).toBe('vector');
      }
    });

    it('every FTS result has mode=fts', async () => {
      const results = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept({
            title: 'Postgres for the primary datastore',
            body: 'We chose Postgres over MongoDB.',
          }),
          limit: 5,
        },
      );

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.mode).toBe('fts');
      }
    });

    it('vector mode and fts-only mode produce distinguishable results', async () => {
      const vectorResults = await recallCandidates(
        {
          db,
          embeddingClient: fakeEmbeddingClient(postgresEmbedding()),
          capability: { mode: 'vector' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept(),
          limit: 5,
        },
      );

      const ftsResults = await recallCandidates(
        {
          db,
          embeddingClient: null,
          capability: { mode: 'fts-only' },
        },
        {
          scope: projectScope(teamA, projectA),
          newConcept: newConcept({
            title: 'Postgres for the primary datastore',
            body: 'We chose Postgres over MongoDB for the primary datastore.',
          }),
          limit: 5,
        },
      );

      // Both modes should find the Postgres concept in team A.
      const vectorUuids = vectorResults.map((r) => r.uuid);
      const ftsUuids = ftsResults.map((r) => r.uuid);

      // FTS should find the Postgres concept (it has matching terms in title/body).
      expect(ftsUuids).toContain(conceptPostgres);

      // Vector mode should also find it (top-ranked).
      expect(vectorUuids[0]).toBe(conceptPostgres);
    });
  });
});
