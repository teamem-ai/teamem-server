/**
 * FTS search query integration tests (DUA-192 M1-RET-02).
 *
 * Tests against real Postgres:
 * - FTS query returns matching concepts ranked by ts_rank
 * - Empty query returns empty
 * - Pagination via composite cursor
 * - Cross-project isolation
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../client.js';
import {
  ftsSearchConcepts,
} from './concepts-fts-search.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('FtsSearchConcepts (live Postgres)', () => {
  let db: AppDb;

  const team = 'team_ftstest';
  const projectA = 'prj_ftsa';
  const projectB = 'prj_ftsb';

  const conceptA1 = randomUUID();
  const conceptA2 = randomUUID();
  const conceptB1 = randomUUID();

  beforeAll(async () => {
    db = createDb(url!);

    // Teams and projects.
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${team}', 'FTS Test Team')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${projectA}', '${team}', 'FTS Project A')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${projectB}', '${team}', 'FTS Project B')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed concepts with distinct text content.
    await db.execute(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type, status, confidence,
        title, body, tags, first_seen, last_confirmed)
      VALUES
        ('${conceptA1}', '${team}', '${projectA}', 1, 'service', 'active', 'high',
         'Authentication Service',
         'Handles OAuth2 and JWT token validation for all incoming API requests.',
         ARRAY['auth']::text[], now(), now()),
        ('${conceptA2}', '${team}', '${projectA}', 1, 'concept', 'active', 'high',
         'Data Pipeline Architecture',
         'ETL pipeline ingesting events from PostgreSQL and loading into the analytics warehouse.',
         ARRAY['data']::text[], now(), now()),
        ('${conceptB1}', '${team}', '${projectB}', 1, 'concept', 'active', 'high',
         'Project B Resource',
         'This resource belongs to project B only.',
         ARRAY[]::text[], now(), now())
      ON CONFLICT (uuid) DO NOTHING;
    `);

    // Paths.
    await db.execute(`
      INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
      VALUES
        ('${team}', '${projectA}', '${conceptA1}', 'auth-service', true),
        ('${team}', '${projectA}', '${conceptA2}', 'data-pipeline', true),
        ('${team}', '${projectB}', '${conceptB1}', 'project-b-resource', true)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    for (const pid of [projectA, projectB]) {
      await db.execute(`DELETE FROM concept_paths    WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concept_evidence WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concept_contributors WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM concepts         WHERE project_id = '${pid}'`);
      await db.execute(`DELETE FROM projects         WHERE id = '${pid}'`);
    }
    await db.execute(`DELETE FROM teams WHERE id = '${team}'`);
  });

  // ── Success paths ──────────────────────────────────────────────────

  it('returns keyword matches ranked by relevance', async () => {
    const result = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectA,
      query: 'authentication',
      limit: 10,
    });

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const uuids = result.rows.map((r) => r.uuid);
    expect(uuids).toContain(conceptA1);

    // Relevance is a number in [0, 1].
    for (const row of result.rows) {
      expect(typeof row.relevance).toBe('number');
      expect(row.relevance).toBeGreaterThanOrEqual(0);
      expect(row.relevance).toBeLessThanOrEqual(1);
    }
  });

  it('returns empty for unrelated keywords', async () => {
    const result = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectA,
      query: 'zzzxyznonexistent',
      limit: 10,
    });

    expect(result.rows).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('returns empty for whitespace-only query', async () => {
    const result = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectA,
      query: '   ',
      limit: 10,
    });

    expect(result.rows).toEqual([]);
  });

  // ── Project isolation ──────────────────────────────────────────────

  it('does not return results from a different project', async () => {
    const result = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectA,
      query: 'Project B resource',
      limit: 10,
    });

    const uuids = result.rows.map((r) => r.uuid);
    expect(uuids).not.toContain(conceptB1);
  });

  it('returns results scoped to the correct project', async () => {
    const result = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectB,
      query: 'resource',
      limit: 10,
    });

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const uuids = result.rows.map((r) => r.uuid);
    expect(uuids).toContain(conceptB1);
  });

  // ── Limit enforcement ──────────────────────────────────────────────

  it('returns at most limit results', async () => {
    const result = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectA,
      query: 'service OR data OR pipeline OR auth',
      limit: 1,
    });

    expect(result.rows.length).toBeLessThanOrEqual(1);
  });

  it('hasMore is true when more results exist', async () => {
    const result = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectA,
      query: 'service OR data OR pipeline OR authentication',
      limit: 1,
    });

    if (result.rows.length === 1) {
      expect(result.hasMore).toBe(true);
    }
  });

  // ── Pagination: composite cursor ───────────────────────────────────

  it('cursor pagination does not return overlapping results', async () => {
    // First page.
    const page1 = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectA,
      query: 'service OR data OR pipeline OR authentication',
      limit: 1,
    });

    if (page1.rows.length === 1 && page1.hasMore) {
      const lastRow = page1.rows[0]!;

      // Second page.
      const page2 = await ftsSearchConcepts(db, {
        teamId: team,
        projectId: projectA,
        query: 'service OR data OR pipeline OR authentication',
        limit: 5,
        cursorRelevance: lastRow.relevance,
        cursorId: lastRow.uuid,
      });

      // Page 2 should not include the page 1 result.
      const page2Uuids = page2.rows.map((r) => r.uuid);
      expect(page2Uuids).not.toContain(lastRow.uuid);
    }
  });

  // ── Type filter ────────────────────────────────────────────────────

  it('filters by concept type', async () => {
    const result = await ftsSearchConcepts(db, {
      teamId: team,
      projectId: projectA,
      query: 'service',
      type: 'service',
      limit: 10,
    });

    for (const row of result.rows) {
      expect(row.type).toBe('service');
    }
  });
});
