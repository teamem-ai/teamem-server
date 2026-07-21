/**
 * Database-constraint integration tests — each test is a counterexample from
 * the 2026-07-17 schema acceptance review, turned into a permanent check.
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres with the initial
 * migration applied (see scripts below); honestly skipped otherwise — no
 * mocked database, per project red line.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   psql < apps/server/drizzle/0000_*.sql
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('schema tenant & idempotency invariants (live Postgres)', () => {
  let db: Client;

  const exec = (sql: string) => db.query(sql);
  const expectViolation = async (sql: string, constraint: string) => {
    await expect(exec(sql)).rejects.toThrow(new RegExp(constraint));
  };

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    // Real seed rows: two teams, one project each.
    await exec(`
      INSERT INTO teams (id, name) VALUES ('team_a', 'A'), ('team_b', 'B');
      INSERT INTO projects (id, team_id, name)
        VALUES ('prj_a', 'team_a', 'PA'), ('prj_b', 'team_b', 'PB');
    `);
  });

  afterAll(async () => {
    await exec(`
      DELETE FROM job_events; DELETE FROM jobs;
      DELETE FROM concept_paths; DELETE FROM concept_evidence;
      DELETE FROM concept_contributors; DELETE FROM concepts;
      DELETE FROM events; DELETE FROM api_keys; DELETE FROM principals;
      DELETE FROM projects; DELETE FROM teams;
    `);
    await db.end();
  });

  const eventInsert = (id: string, team: string, project: string, delivery = 'dk1') => `
    INSERT INTO events (id, team_id, project_id, channel, kind, connector_kind,
      delivery_id, item_key, external_id, actor_provenance, occurred_at,
      occurred_at_provenance, payload, payload_bytes, payload_hash,
      payload_schema_version, envelope_version)
    VALUES ('${id}', '${team}', '${project}', 'cli', 'cli_init', 'cli', '${delivery}',
      'root', 'x', 'unknown', now(), 'server', '{}', 2, 'h1', 1, 1)`;

  it('review issue 1: cross-tenant project mismatch is rejected (composite FK)', async () => {
    // team_b claiming team_a's project — accepted by the old schema.
    await expectViolation(eventInsert('evt_x1', 'team_b', 'prj_a'), 'events_project_fk');
    await exec(eventInsert('evt_ok', 'team_a', 'prj_a')); // sane row passes
  });

  it('review issue 1b: N1 four-element idempotency still enforced', async () => {
    await expectViolation(eventInsert('evt_dup', 'team_a', 'prj_a'), 'events_idempotency_uq');
  });

  it('review issue 2: current path and alias share ONE namespace (N5)', async () => {
    await exec(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type,
        status, confidence, title, body, first_seen, last_confirmed)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'team_a', 'prj_a', 1,
         'service', 'active', 'high', 'A', '', now(), now()),
        ('22222222-2222-4222-8222-222222222222', 'team_a', 'prj_a', 1,
         'service', 'active', 'high', 'B', '', now(), now());
      INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
      VALUES ('team_a', 'prj_a', '11111111-1111-4111-8111-111111111111', 'services/a', true);
    `);
    // Concept B trying to register services/a as alias OR current path → rejected.
    await expectViolation(
      `INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
       VALUES ('team_a', 'prj_a', '22222222-2222-4222-8222-222222222222', 'services/a', false)`,
      'concept_paths_namespace_uq',
    );
    // A concept cannot have two current paths.
    await expectViolation(
      `INSERT INTO concept_paths (team_id, project_id, concept_uuid, path, is_current)
       VALUES ('team_a', 'prj_a', '11111111-1111-4111-8111-111111111111', 'services/a2', true)`,
      'concept_paths_current_uq',
    );
  });

  it('review issue 3: api_keys least-privilege invariant is a CHECK, not a comment (N6)', async () => {
    // project_id null + all_projects false — accepted by the old schema.
    await expectViolation(
      `INSERT INTO api_keys (id, team_id, name, token_hash, scopes, all_projects)
       VALUES ('key_bad', 'team_a', 'k', 'h_bad', '{read}', false)`,
      'api_keys_least_privilege_ck',
    );
    // read:payload without read — scope superset rule (N7).
    await expectViolation(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('key_bad2', 'team_a', 'prj_a', 'k', 'h_bad2', '{read:payload}', false)`,
      'api_keys_scope_superset_ck',
    );
    await exec(
      `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
       VALUES ('key_ok', 'team_a', 'prj_a', 'k', 'h_ok', '{read,read:payload}', false)`,
    );
  });

  it('review issue 4: job idempotency is scoped by kind (N1)', async () => {
    const job = (id: string, kind: string, key: string) => `
      INSERT INTO jobs (id, team_id, project_id, kind, initiated_by_kind,
        idempotency_key, idempotency_request_hash, event_count)
      VALUES ('${id}', 'team_a', 'prj_a', '${kind}', 'credential', '${key}', 'rh', 1)`;
    await exec(job('33333333-3333-4333-8333-333333333333', 'ingest_batch', 'ik1'));
    // Same key, same kind → blocked (replay handled in app via request hash).
    await expectViolation(
      job('44444444-4444-4444-8444-444444444444', 'ingest_batch', 'ik1'),
      'jobs_idempotency_uq',
    );
    // Same key, DIFFERENT kind → legal, no false collision.
    await exec(job('55555555-5555-4555-8555-555555555555', 'compilation', 'ik1'));
  });

  it('job_events binds job and event to the same tenant (composite FKs)', async () => {
    // evt_ok belongs to prj_a; a job in prj_b cannot claim it.
    await exec(`
      INSERT INTO projects (id, team_id, name) VALUES ('prj_a2', 'team_a', 'PA2');
      INSERT INTO jobs (id, team_id, project_id, kind, initiated_by_kind, event_count)
      VALUES ('66666666-6666-4666-8666-666666666666', 'team_a', 'prj_a2', 'ingest_event', 'credential', 1);
    `);
    await expectViolation(
      `INSERT INTO job_events (team_id, project_id, job_id, event_id)
       VALUES ('team_a', 'prj_a2', '66666666-6666-4666-8666-666666666666', 'evt_ok')`,
      'job_events_event_fk',
    );
  });

  // ── DUA-190: Full-text search tsvector column & GIN index ───────────────

  it('DUA-190: search_tsv is auto-populated on insert (generated column)', async () => {
    await exec(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type,
        status, confidence, title, body, first_seen, last_confirmed)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'team_a', 'prj_a', 1,
        'concept', 'active', 'high',
        'PostgreSQL Full-Text Search',
        'Full-text search enables efficient text lookup in PostgreSQL using tsvector and GIN indexes.',
        now(), now());
    `);
    const { rows } = await db.query(
      `SELECT search_tsv FROM concepts WHERE uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
    );
    expect(rows[0]).toBeDefined();
    // The generated column must be non-null.
    expect(rows[0].search_tsv).not.toBeNull();
    // Should contain tokens from both title and body.
    expect(typeof rows[0].search_tsv).toBe('string');
    expect(rows[0].search_tsv).toContain('postgresql');
    expect(rows[0].search_tsv).toContain('full-text');
    expect(rows[0].search_tsv).toContain('search');
    expect(rows[0].search_tsv).toContain('gin');
  });

  it('DUA-190: to_tsquery with simple config matches inserted concept', async () => {
    await exec(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type,
        status, confidence, title, body, first_seen, last_confirmed)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'team_a', 'prj_a', 1,
        'decision', 'active', 'high',
        'Use TypeScript for Backend',
        'We decided to use TypeScript on the server side for type safety and maintainability.',
        now(), now());
    `);
    // GIN-indexed search via @@ operator.
    const { rows: match } = await db.query(
      `SELECT uuid, title FROM concepts
       WHERE search_tsv @@ to_tsquery('simple', 'typescript')
         AND uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`,
    );
    expect(match).toHaveLength(1);
    expect(match[0].title).toBe('Use TypeScript for Backend');

    // Non-matching term should return no rows.
    const { rows: noMatch } = await db.query(
      `SELECT uuid FROM concepts
       WHERE search_tsv @@ to_tsquery('simple', 'python')
         AND uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`,
    );
    expect(noMatch).toHaveLength(0);
  });

  it('DUA-190: tsvector updates when title or body changes (generated)', async () => {
    await exec(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type,
        status, confidence, title, body, first_seen, last_confirmed)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'team_a', 'prj_a', 1,
        'concept', 'active', 'high',
        'Original Title', 'Original body content.',
        now(), now());
    `);
    // Verify initial state.
    let { rows } = await db.query(
      `SELECT search_tsv FROM concepts WHERE uuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'`,
    );
    expect(rows[0].search_tsv).toContain('original');
    expect(rows[0].search_tsv).toContain('titl'); // simple config doesn't stem; 'title' stays 'title'

    // Update the title.
    await exec(`
      UPDATE concepts SET title = 'Updated Architecture',
        updated_at = now()
      WHERE uuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    `);
    ({ rows } = await db.query(
      `SELECT search_tsv FROM concepts WHERE uuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'`,
    ));
    expect(rows[0].search_tsv).toContain('updated');
    expect(rows[0].search_tsv).toContain('architecture');
    // Title-only tokens from old title are gone ('title' was only in the
    // old title; 'original' appears in both old title AND body so it
    // survives — we must pick a word unique to the old title).
    expect(rows[0].search_tsv).not.toContain(" 'title':");
    // Body tokens still present.
    expect(rows[0].search_tsv).toContain('original');
    expect(rows[0].search_tsv).toContain('body');
    expect(rows[0].search_tsv).toContain('content');
  });

  it('DUA-190: simple config preserves CJK and non-English tokens', async () => {
    await exec(`
      INSERT INTO concepts (uuid, team_id, project_id, schema_version, type,
        status, confidence, title, body, first_seen, last_confirmed)
      VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'team_a', 'prj_a', 1,
        'convention', 'active', 'high',
        '中文全文检索测试',
        '这是一个中文全文检索的测试页面，用于验证 simple 配置不会丢弃非英文内容。',
        now(), now());
    `);
    const { rows } = await db.query(
      `SELECT uuid, title FROM concepts
       WHERE search_tsv @@ to_tsquery('simple', '中文全文检索测试')
         AND uuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('中文全文检索测试');
  });

  it('DUA-190: GIN index is present on search_tsv', async () => {
    const { rows } = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'concepts' AND indexname = 'concepts_search_fts_gin'
    `);
    expect(rows).toHaveLength(1);
  });
});
