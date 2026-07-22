/**
 * Semantic capability detection tests (M1-EMB-03).
 *
 * Covers:
 *  - CLI acceptance step 1: non-null client → mode=vector; null → mode=fts-only
 *  - CLI acceptance step 2: fts-only mode concept write does not fail
 *    (embedding column is nullable — verified via the real DB integration test)
 *  - Degradation observability: the log callback is invoked with a descriptive
 *    message when falling back to fts-only
 *  - Boundary: the function is pure and never throws
 *  - Schema assertion: the concepts.embedding column is nullable (not .notNull())
 *
 * The function tests at the top use a lightweight mock EmbeddingClient so they
 * are pure unit tests (no database). The integration test at the bottom runs
 * against real Postgres to verify the embedding column is nullable and concept
 * write succeeds without an embedding value.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type AppDb } from '../../db/client.js';
import * as schema from '../../db/schema.js';
import {
  createConcept,
  type CreateConceptInput,
} from '../../db/repositories/concepts-write.js';
import type { EmbeddingClient } from './port.js';
import { resolveSemanticCapability, type SemanticCapability } from './capability.js';

// ── Lightweight mock EmbeddingClient ────────────────────────────────────────

function mockEmbeddingClient(): EmbeddingClient {
  return {
    generate: async (inputs: string[]) => {
      // Return zero-vectors of correct dimension; tests never call this.
      return inputs.map(() => new Array(1536).fill(0));
    },
  };
}

// ── CLI acceptance step 1: mode resolution ──────────────────────────────────

describe('resolveSemanticCapability', () => {
  it('returns { mode: "vector" } when embeddingClient is non-null', () => {
    const client = mockEmbeddingClient();
    const result = resolveSemanticCapability(client);
    expect(result).toEqual({ mode: 'vector' } satisfies SemanticCapability);
  });

  it('returns { mode: "fts-only" } when embeddingClient is null', () => {
    const result = resolveSemanticCapability(null);
    expect(result).toEqual({ mode: 'fts-only' } satisfies SemanticCapability);
  });

  it('is a pure function — same input, same output', () => {
    const client = mockEmbeddingClient();
    expect(resolveSemanticCapability(client)).toEqual({ mode: 'vector' });
    expect(resolveSemanticCapability(client)).toEqual({ mode: 'vector' });
    expect(resolveSemanticCapability(null)).toEqual({ mode: 'fts-only' });
    expect(resolveSemanticCapability(null)).toEqual({ mode: 'fts-only' });
  });

  it('never throws — handles null gracefully', () => {
    expect(() => resolveSemanticCapability(null)).not.toThrow();
    expect(() => resolveSemanticCapability(mockEmbeddingClient())).not.toThrow();
  });
});

// ── Degradation observability ──────────────────────────────────────────────

describe('degradation observability', () => {
  it('calls the log callback with a descriptive message when degrading to fts-only', () => {
    const messages: string[] = [];
    const log = (msg: string) => messages.push(msg);

    const result = resolveSemanticCapability(null, { log });

    expect(result).toEqual({ mode: 'fts-only' });
    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain('fts-only');
    expect(messages[0]!).toContain('no embedding client');
    expect(messages[0]!).toContain('openai');
    expect(messages[0]!).toContain('openrouter');
    expect(messages[0]!).toContain('custom');
  });

  it('does NOT call the log callback when in vector mode', () => {
    const messages: string[] = [];
    const log = (msg: string) => messages.push(msg);

    const result = resolveSemanticCapability(mockEmbeddingClient(), { log });

    expect(result).toEqual({ mode: 'vector' });
    expect(messages).toHaveLength(0);
  });

  it('does not throw when log callback is omitted (undefined)', () => {
    // Without `log`, the function still works — just less observable.
    expect(() => resolveSemanticCapability(null)).not.toThrow();
    expect(() => resolveSemanticCapability(null, {})).not.toThrow();
  });
});

// ── Schema assertion: embedding column is nullable ─────────────────────────

describe('concepts.embedding column nullability', () => {
  it('the embedding column is nullable (not .notNull()) so fts-only writes succeed', () => {
    // The concepts table column definition:
    //   embedding: vector('embedding', { dimensions: 1536 })
    // has NO .notNull() modifier, so NULL is a legal value.
    // When the deployment is fts-only, createConcept leaves embedding unset,
    // and the database stores NULL — this is the intentional degradation path.
    const col = schema.concepts.embedding;
    // Drizzle's internal `notNull` reflects whether .notNull() was called.
    // On a nullable column it is `false`; on a .notNull() column it is `true`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((col as any).notNull).toBe(false);
  });
});

// ── CLI acceptance step 2: concept write in fts-only mode ──────────────────
//    Runs against real Postgres to confirm that a concept page write succeeds
//    when the embedding column is left NULL — the legal degradation state.

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('fts-only concept write (live Postgres)', () => {
  let db: AppDb;
  const testTeam = 'team_emb03_fts';
  const testProject = 'prj_emb03_fts';

  beforeAll(async () => {
    db = createDb(url!);
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${testTeam}', 'EMB03 FTS Tests')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.execute(`
      INSERT INTO projects (id, team_id, name) VALUES ('${testProject}', '${testTeam}', 'EMB03 Project')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    await db.execute(`
      DELETE FROM concept_evidence      WHERE team_id = '${testTeam}';
      DELETE FROM concept_paths         WHERE team_id = '${testTeam}';
      DELETE FROM concepts              WHERE team_id = '${testTeam}';
      DELETE FROM projects              WHERE id = '${testProject}';
      DELETE FROM teams                 WHERE id = '${testTeam}';
    `);
  });

  beforeEach(async () => {
    await db.execute(`
      DELETE FROM concept_evidence      WHERE team_id = '${testTeam}';
      DELETE FROM concept_paths         WHERE team_id = '${testTeam}';
      DELETE FROM concepts              WHERE team_id = '${testTeam}';
    `);
  });

  it('creates a concept page successfully with NULL embedding (fts-only degradation)', async () => {
    const path = `fts-test-${randomUUID()}`;

    const input: CreateConceptInput = {
      teamId: testTeam,
      projectId: testProject,
      schemaVersion: 1,
      type: 'concept',
      status: 'active',
      confidence: 'medium',
      title: 'FTS-Only Concept',
      body: 'This concept was created in fts-only mode — embedding is NULL.',
      tags: ['fts', 'test'],
      firstSeen: new Date('2025-06-01T00:00:00.000Z'),
      lastConfirmed: new Date('2025-06-01T00:00:00.000Z'),
      path,
      evidence: [
        {
          kind: 'mcp_write',
          ref: 'evt_fts_test_01',
          at: new Date('2025-06-01T00:00:00.000Z'),
        },
      ],
    };

    // createConcept does NOT include `embedding` in its insert values,
    // so the database stores NULL — the legal fts-only degradation state.
    const result = await createConcept(db, input);

    expect(result.uuid).toBeTruthy();

    // Verify the concept row was persisted.
    const rows = await db
      .select()
      .from(schema.concepts)
      .where(eq(schema.concepts.uuid, result.uuid));
    expect(rows).toHaveLength(1);

    // The embedding column MUST be NULL — this is the fts-only degradation.
    const concept = rows[0]!;
    expect(concept.embedding).toBeNull();

    // The title and body are correct, confirming the row is our concept.
    expect(concept.title).toBe('FTS-Only Concept');
    expect(concept.body).toBe('This concept was created in fts-only mode — embedding is NULL.');

    // searchTsv is still generated by the database (GENERATED ALWAYS AS STORED)
    // so FTS queries work even without vector search.
  });
});
