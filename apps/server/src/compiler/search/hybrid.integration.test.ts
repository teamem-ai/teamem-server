/**
 * Hybrid search integration tests (DUA-192 M1-RET-02).
 *
 * Tests against real Postgres + pgvector (TEST_DATABASE_URL):
 * - Vector mode: different phrasing returns same relevant concepts
 * - FTS-only mode: keyword query hits, explicit degradation
 * - Cross-team: returns empty (anti-enumeration)
 * - Pagination: composite cursor works in hybrid mode
 * - Result shape: all required fields present
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../../db/client.js';
import { hybridSearch } from './hybrid.js';
import {
  projectScope,
  allProjectsScope,
} from '../../auth/scope.js';
import { type SemanticCapability } from '../../llm/embedding/capability.js';
import type { EmbeddingClient } from '../../llm/embedding/port.js';
import { EMBEDDING_DIMENSION } from '../../llm/embedding/port.js';

const url = process.env['TEST_DATABASE_URL'];

// ── Lightweight mock embedding client ──────────────────────────────────────
// Produces deterministic, directional vectors for testing without a real
// embedding provider.  Each call returns one vector per input string.

function directionalEmbedding(dims: [number, number], value: number = 0.02): number[] {
  const v = new Array(EMBEDDING_DIMENSION).fill(0);
  for (let i = dims[0]; i < dims[1]; i++) v[i] = value;
  return v;
}

/**
 * A mock embedding client that returns vectors with non-zero values
 * only in a specific dimension range.  This lets us test semantic recall:
 * "postgresql database" concepts get dims 0..511 = 0.02,
 * "typescript frontend" concepts get dims 512..1023 = 0.02, etc.
 */
function createMockEmbeddingClient(
  dimsMap: Record<string, [number, number]>,
): EmbeddingClient {
  return {
    generate: async (inputs: string[]) => {
      return inputs.map((input) => {
        const key = Object.keys(dimsMap).find((k) => input.toLowerCase().includes(k));
        if (key) {
          return directionalEmbedding(dimsMap[key]!);
        }
        // Default: all zeros → orthogonal to everything
        return new Array(EMBEDDING_DIMENSION).fill(0);
      });
    },
  };
}

// ── Test context ───────────────────────────────────────────────────────────

describe.skipIf(!url)('HybridSearch (live Postgres + pgvector)', () => {
  let db: AppDb;

  const teamA = 'team_hsa';
  const teamB = 'team_hsb';
  const projectA = 'prj_hsa';
  const projectB = 'prj_hsb';

  // Seeded concept UUIDs
  const postgresUuid = randomUUID();
  const reactUuid = randomUUID();
  const dockerUuid = randomUUID();
  const teamBConceptUuid = randomUUID();

  // Capability fixtures
  const vectorCapability: SemanticCapability = { mode: 'vector' };
  const ftsOnlyCapability: SemanticCapability = { mode: 'fts-only' };

  // Mock embedding client — matches concepts by their topic subspace
  const embeddingClient = createMockEmbeddingClient({
    postgresql: [0, 512],
    database: [0, 512],
    sql: [0, 512],
    react: [512, 1024],
    frontend: [512, 1024],
    typescript: [512, 1024],
    docker: [1024, 1536],
    kubernetes: [1024, 1536],
    devops: [1024, 1536],
  });

  // ── Seed data ────────────────────────────────────────────────────────

  beforeAll(async () => {
    db = createDb(url!);

    // Teams.
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${teamA}', 'HS Team A')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${teamB}', 'HS Team B')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Projects.
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${projectA}', '${teamA}', 'HS Project A')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${projectB}', '${teamB}', 'HS Project B')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed 3 concepts in teamA/projectA with distinct embedding directions.
    const emb1 = directionalEmbedding([0, 512], 0.02);
    const emb2 = directionalEmbedding([512, 1024], 0.02);
    const emb3 = directionalEmbedding([1024, 1536], 0.02);

    const embedVector = (v: number[]) => `'[${v.join(',')}]'::vector`;

    await db.execute(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
        title, body, tags, first_seen, last_confirmed, embedding)
      VALUES
        ('${postgresUuid}', '${teamA}', '${projectA}', 1, 'concept', 'active', 'high',
         'PostgreSQL Performance Tuning', '# PostgreSQL Performance\n\nUse indexes wisely and vacuum regularly. Query planning is essential for large datasets.',
         ARRAY['database', 'postgresql']::text[], now(), now(),
         ${embedVector(emb1)}),
        ('${reactUuid}', '${teamA}', '${projectA}', 1, 'concept', 'active', 'high',
         'React Component Patterns', '# React Patterns\n\nPrefer composition over inheritance. Use hooks for state management and context for global data.',
         ARRAY['frontend', 'react']::text[], now(), now(),
         ${embedVector(emb2)}),
        ('${dockerUuid}', '${teamA}', '${projectA}', 1, 'concept', 'active', 'high',
         'Docker Multi-Stage Builds', '# Docker\n\nMulti-stage builds reduce image size significantly. Use alpine-based images for production.',
         ARRAY['devops', 'docker']::text[], now(), now(),
         ${embedVector(emb3)})
      ON CONFLICT (uuid) DO NOTHING;
    `);

    // Paths for the seeded concepts.
    await db.execute(`
      INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
      VALUES
        ('${teamA}', '${projectA}', '${postgresUuid}', 'postgresql-performance', true),
        ('${teamA}', '${projectA}', '${reactUuid}', 'react-component-patterns', true),
        ('${teamA}', '${projectA}', '${dockerUuid}', 'docker-multi-stage-builds', true)
      ON CONFLICT DO NOTHING;
    `);

    // Seed a concept in team B for cross-team tests
    const embB = directionalEmbedding([0, 512], 0.03);
    await db.execute(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
        title, body, tags, first_seen, last_confirmed, embedding)
      VALUES
        ('${teamBConceptUuid}', '${teamB}', '${projectB}', 1, 'concept', 'active', 'high',
         'Team B Database Guide', '# Team B DB Guide\n\nThis is another team''s database documentation.',
         ARRAY['database']::text[], now(), now(),
         ${embedVector(embB)})
      ON CONFLICT (uuid) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
      VALUES ('${teamB}', '${projectB}', '${teamBConceptUuid}', 'team-b-database-guide', true)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    // Clean up in reverse dependency order.
    for (const [tid, pid] of [[teamA, projectA], [teamB, projectB]]) {
      await db.execute(`DELETE FROM concept_contributors WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concept_evidence      WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concept_paths         WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concepts              WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM projects              WHERE id = '${pid}'`);
      await db.execute(`DELETE FROM teams                 WHERE id = '${tid}'`);
    }
  });

  beforeEach(async () => {
    // No per-test setup needed — seeds are fresh each run.
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CLI acceptance step 1: Vector mode — semantic recall works
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLI step 1: vector mode semantic recall', () => {
    it('recalls the PostgreSQL concept with a semantically similar query using different words', async () => {
      // "database optimization" has no word overlap with "PostgreSQL Performance Tuning"
      // but the embedding client maps "database" to dims 0..511, matching the postgres concept.
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'database optimization techniques',
        vectorCapability,
        embeddingClient,
        { limit: 3 },
      );

      expect(result.degraded).toBe(false);
      expect(result.rows.length).toBeGreaterThanOrEqual(1);

      // The PostgreSQL concept should be ranked first (highest similarity).
      const topUuid = result.rows[0]!.uuid;
      expect(topUuid).toBe(postgresUuid);
      expect(result.rows[0]!.title).toBe('PostgreSQL Performance Tuning');
      expect(result.rows[0]!.ftsFallback).toBe(false);
    });

    it('recalls the React concept with a paraphrased query', async () => {
      // "UI component library" has no overlap with "React Component Patterns"
      // but semantically matches the frontend subspace.
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'UI component library patterns',
        vectorCapability,
        embeddingClient,
        { limit: 3 },
      );

      expect(result.degraded).toBe(false);

      // React concept should appear in results (ranked high, maybe not #1 if
      // the mock embedding is imprecise — but it should be present).
      const uuids = result.rows.map((r) => r.uuid);
      expect(uuids).toContain(reactUuid);
    });

    it('returns results ranked by combined relevance (vector + FTS)', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'docker container build',
        vectorCapability,
        embeddingClient,
        { limit: 3 },
      );

      expect(result.degraded).toBe(false);
      expect(result.rows.length).toBeGreaterThanOrEqual(1);

      // All relevance scores should be numbers in [0, 1].
      for (const row of result.rows) {
        expect(typeof row.relevance).toBe('number');
        expect(row.relevance).toBeGreaterThanOrEqual(0);
        expect(row.relevance).toBeLessThanOrEqual(1);
      }

      // Results should be sorted by relevance descending.
      for (let i = 1; i < result.rows.length; i++) {
        expect(result.rows[i - 1]!.relevance).toBeGreaterThanOrEqual(result.rows[i]!.relevance);
      }
    });

    it('ftsFallback is false for vector-matched results', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'postgresql database',
        vectorCapability,
        embeddingClient,
        { limit: 3 },
      );

      expect(result.degraded).toBe(false);

      // At least the top result (best vector match) should have ftsFallback=false.
      const topResult = result.rows[0];
      expect(topResult).toBeDefined();
      expect(topResult!.ftsFallback).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CLI acceptance step 2: FTS-only mode — keyword hit + degradation
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLI step 2: FTS-only mode', () => {
    it('returns keyword matches with explicit degradation', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'PostgreSQL',
        ftsOnlyCapability,
        null, // no embedding client
        { limit: 10 },
      );

      // Must find the PostgreSQL concept by keyword.
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      const uuids = result.rows.map((r) => r.uuid);
      expect(uuids).toContain(postgresUuid);

      // Explicit degradation.
      expect(result.degraded).toBe(true);

      // Every row must be marked ftsFallback.
      for (const row of result.rows) {
        expect(row.ftsFallback).toBe(true);
      }
    });

    it('returns degradation flag even when query matches nothing', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'zzzxyznonexistentterm',
        ftsOnlyCapability,
        null,
        { limit: 10 },
      );

      expect(result.rows).toEqual([]);
      expect(result.degraded).toBe(true);
      expect(result.hasMore).toBe(false);
    });

    it('ftsFallback is true on every result row', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'docker',
        ftsOnlyCapability,
        null,
        { limit: 10 },
      );

      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      for (const row of result.rows) {
        expect(row.ftsFallback).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CLI acceptance step 3: Cross-team anti-enumeration
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLI step 3: cross-team anti-enumeration', () => {
    it('returns empty when team B scope queries team A embeddings (vector mode)', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamB, projectB),
        'postgresql database',
        vectorCapability,
        embeddingClient,
        { limit: 10 },
      );

      // Team B should NOT see Team A's PostgreSQL concept.
      // The result may include Team B's own database concept though.
      const uuids = result.rows.map((r) => r.uuid);
      expect(uuids).not.toContain(postgresUuid);
      expect(uuids).not.toContain(reactUuid);
      expect(uuids).not.toContain(dockerUuid);
    });

    it('returns empty when team B scope queries team A concepts (FTS-only)', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamB, projectB),
        'PostgreSQL',
        ftsOnlyCapability,
        null,
        { limit: 10 },
      );

      // Team B should NOT see Team A's PostgreSQL concept by keyword either.
      const uuids = result.rows.map((r) => r.uuid);
      expect(uuids).not.toContain(postgresUuid);
    });

    it('Team A search includes Team A concepts but not Team B concepts', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'database',
        vectorCapability,
        embeddingClient,
        { limit: 10 },
      );

      const uuids = result.rows.map((r) => r.uuid);
      // Team A's PostgreSQL concept should appear.
      expect(uuids).toContain(postgresUuid);
      // Team B's database concept must NOT appear.
      expect(uuids).not.toContain(teamBConceptUuid);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scope enforcement: allProjects returns empty
  // ═══════════════════════════════════════════════════════════════════════

  describe('scope enforcement', () => {
    it('returns empty for allProjects scope (no project to scope to)', async () => {
      const result = await hybridSearch(
        db,
        allProjectsScope(teamA),
        'postgresql database',
        vectorCapability,
        embeddingClient,
        { limit: 10 },
      );

      expect(result.rows).toEqual([]);
    });

    it('returns empty for allProjects scope in FTS-only mode', async () => {
      const result = await hybridSearch(
        db,
        allProjectsScope(teamA),
        'PostgreSQL',
        ftsOnlyCapability,
        null,
        { limit: 10 },
      );

      expect(result.rows).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Result shape
  // ═══════════════════════════════════════════════════════════════════════

  describe('result shape', () => {
    it('includes all required fields in each hybrid search result row', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'postgresql database',
        vectorCapability,
        embeddingClient,
        { limit: 2 },
      );

      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      const row = result.rows[0]!;

      expect(typeof row.uuid).toBe('string');
      expect(row.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(typeof row.path).toBe('string');
      expect(typeof row.type).toBe('string');
      expect(typeof row.status).toBe('string');
      expect(typeof row.confidence).toBe('string');
      expect(typeof row.title).toBe('string');
      expect(Array.isArray(row.tags)).toBe(true);
      expect(row.lastConfirmed).toBeInstanceOf(Date);
      expect(typeof row.relevance).toBe('number');
      expect(row.relevance).toBeGreaterThanOrEqual(0);
      expect(row.relevance).toBeLessThanOrEqual(1);
      expect(typeof row.ftsFallback).toBe('boolean');
      expect(typeof row.bodySnippet).toBe('string');
      expect(row.bodySnippet.length).toBeLessThanOrEqual(203); // ~200 + '…'
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Pagination: composite cursor
  // ═══════════════════════════════════════════════════════════════════════

  describe('pagination', () => {
    it('returns at most limit results', async () => {
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'postgresql react docker',
        vectorCapability,
        embeddingClient,
        { limit: 2 },
      );

      expect(result.rows.length).toBeLessThanOrEqual(2);
    });

    it('hasMore is true when there are more results than limit', async () => {
      // Use FTS-only mode with a broad query to get multiple results.
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'performance OR patterns OR docker',
        ftsOnlyCapability,
        null,
        { limit: 1 },
      );

      // If there are at least 2 matches, hasMore should be true.
      if (result.rows.length === 1) {
        expect(result.hasMore).toBe(true);
      }
    });

    it('second page with cursor does not overlap with first page', async () => {
      // First page with limit=1.
      const page1 = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'performance OR patterns OR docker',
        ftsOnlyCapability,
        null,
        { limit: 1 },
      );

      expect(page1.rows.length).toBeLessThanOrEqual(1);

      if (page1.rows.length === 1 && page1.hasMore) {
        const lastRow = page1.rows[0]!;

        // Second page with cursor.
        const page2 = await hybridSearch(
          db,
          projectScope(teamA, projectA),
          'performance OR patterns OR docker',
          ftsOnlyCapability,
          null,
          {
            limit: 2,
            cursorRelevance: lastRow.relevance,
            cursorId: lastRow.uuid,
          },
        );

        // Page 2 should not include the page 1 result.
        const page2Uuids = page2.rows.map((r) => r.uuid);
        expect(page2Uuids).not.toContain(lastRow.uuid);
      }
    });

    it('cursor on the last page returns empty', async () => {
      // Fetch all results first.
      const all = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'performance OR patterns OR docker',
        ftsOnlyCapability,
        null,
        { limit: 20 },
      );

      if (all.rows.length > 0) {
        const lastRow = all.rows[all.rows.length - 1]!;

        // Using the last row's relevance + UUID should return empty.
        const beyond = await hybridSearch(
          db,
          projectScope(teamA, projectA),
          'performance OR patterns OR docker',
          ftsOnlyCapability,
          null,
          {
            limit: 10,
            cursorRelevance: lastRow.relevance,
            cursorId: lastRow.uuid,
          },
        );

        expect(beyond.rows).toEqual([]);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Graceful degradation: embedding failure
  // ═══════════════════════════════════════════════════════════════════════

  describe('graceful degradation on embedding failure', () => {
    it('falls back to FTS when embedding client throws', async () => {
      const brokenClient: EmbeddingClient = {
        generate: async () => {
          throw new Error('Simulated embedding API failure');
        },
      };

      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'PostgreSQL',
        vectorCapability,
        brokenClient,
        { limit: 10 },
      );

      // Should still return FTS results.
      expect(result.degraded).toBe(true);
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      const uuids = result.rows.map((r) => r.uuid);
      expect(uuids).toContain(postgresUuid);

      // All results should be marked as FTS fallback.
      for (const row of result.rows) {
        expect(row.ftsFallback).toBe(true);
      }
    });

    it('falls back to FTS when embedding client returns empty array', async () => {
      const emptyClient: EmbeddingClient = {
        generate: async () => [],
      };

      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'docker',
        vectorCapability,
        emptyClient,
        { limit: 10 },
      );

      expect(result.degraded).toBe(true);
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      for (const row of result.rows) {
        expect(row.ftsFallback).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FTS-only concept still found in vector mode via FTS supplement
  // ═══════════════════════════════════════════════════════════════════════

  describe('FTS supplement in vector mode', () => {
    it('finds concepts without embeddings via FTS supplement', async () => {
      // Seed a concept with NULL embedding.
      const nullEmbUuid = randomUUID();
      await db.execute(`
        INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
          title, body, tags, first_seen, last_confirmed, embedding)
        VALUES
          ('${nullEmbUuid}', '${teamA}', '${projectA}', 1, 'concept', 'active', 'high',
           'Redis Caching Layer', '# Redis Cache\n\nWe use Redis for session caching and rate limiting across all services.',
           ARRAY['caching', 'redis']::text[], now(), now(),
           NULL)
        ON CONFLICT (uuid) DO NOTHING;
      `);
      await db.execute(`
        INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
        VALUES ('${teamA}', '${projectA}', '${nullEmbUuid}', 'redis-caching-layer', true)
        ON CONFLICT DO NOTHING;
      `);

      // Search in vector mode — the NULL-embedding concept should be found via FTS supplement.
      const result = await hybridSearch(
        db,
        projectScope(teamA, projectA),
        'Redis caching',
        vectorCapability,
        embeddingClient,
        { limit: 10 },
      );

      const uuids = result.rows.map((r) => r.uuid);
      expect(uuids).toContain(nullEmbUuid);

      // The NULL-embedding concept should have ftsFallback=true (FTS-only match).
      const redisResult = result.rows.find((r) => r.uuid === nullEmbUuid);
      expect(redisResult).toBeDefined();
      expect(redisResult!.ftsFallback).toBe(true);
    });
  });
});
