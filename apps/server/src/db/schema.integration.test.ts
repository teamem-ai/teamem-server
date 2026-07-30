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
      DELETE FROM memberships; DELETE FROM invites;
      DELETE FROM web_sessions; DELETE FROM users;
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

  // ── DUA-222: M2 auth tables — users, sessions, invites, memberships ──

  it('DUA-222: users table has expected columns and unique github_id', async () => {
    // Insert a user.
    await exec(`
      INSERT INTO users (id, github_id, github_login, avatar_url)
      VALUES ('usr_test', 12345, 'testuser', 'https://avatars.githubusercontent.com/u/12345')
    `);
    const { rows } = await db.query(
      `SELECT * FROM users WHERE id = 'usr_test'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].github_id).toBe(12345);
    expect(rows[0].github_login).toBe('testuser');
  });

  it('DUA-222: duplicate github_id is rejected (unique constraint)', async () => {
    await exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES ('usr_a', 99991, 'user_a')
    `);
    await expectViolation(
      `INSERT INTO users (id, github_id, github_login)
       VALUES ('usr_b', 99991, 'user_b')`,
      'users_github_id_unique',
    );
  });

  it('DUA-222: duplicate (user_id, team_id) membership is rejected (PK)', async () => {
    await exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES ('usr_mem', 99992, 'member_user')
    `);
    await exec(`
      INSERT INTO memberships (user_id, team_id, role)
      VALUES ('usr_mem', 'team_a', 'viewer')
    `);
    await expectViolation(
      `INSERT INTO memberships (user_id, team_id, role)
       VALUES ('usr_mem', 'team_a', 'admin')`,
      'memberships_user_id_team_id_pk',
    );
  });

  it('DUA-222: membership with non-existent user_id is rejected (FK)', async () => {
    await expectViolation(
      `INSERT INTO memberships (user_id, team_id, role)
       VALUES ('usr_nonexistent', 'team_a', 'viewer')`,
      'memberships_user_id_users_id_fk',
    );
  });

  it('DUA-222: membership with non-existent team_id is rejected (FK)', async () => {
    await exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES ('usr_fk', 99993, 'fk_user')
    `);
    await expectViolation(
      `INSERT INTO memberships (user_id, team_id, role)
       VALUES ('usr_fk', 'team_nonexistent', 'viewer')`,
      'memberships_team_id_teams_id_fk',
    );
  });

  it('DUA-222: invites FK to teams and users is enforced', async () => {
    await exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES ('usr_inviter', 99994, 'inviter')
    `);
    // Valid insert.
    await exec(`
      INSERT INTO invites (id, team_id, token_hash, target_role,
        invited_by_user_id, expires_at)
      VALUES ('inv_ok', 'team_a', 'hash_abc', 'viewer',
        'usr_inviter', now() + interval '7 days')
    `);
    // Bad team FK.
    await expectViolation(
      `INSERT INTO invites (id, team_id, token_hash, target_role,
        invited_by_user_id, expires_at)
       VALUES ('inv_bad_team', 'team_nonexistent', 'hash_bad1', 'viewer',
        'usr_inviter', now() + interval '7 days')`,
      'invites_team_id_teams_id_fk',
    );
    // Bad user FK.
    await expectViolation(
      `INSERT INTO invites (id, team_id, token_hash, target_role,
        invited_by_user_id, expires_at)
       VALUES ('inv_bad_user', 'team_a', 'hash_bad2', 'viewer',
        'usr_nonexistent', now() + interval '7 days')`,
      'invites_invited_by_user_id_users_id_fk',
    );
  });

  it('DUA-222: invite token_hash is unique', async () => {
    await exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES ('usr_inviter2', 99995, 'inviter2')
    `);
    await exec(`
      INSERT INTO invites (id, team_id, token_hash, target_role,
        invited_by_user_id, expires_at)
      VALUES ('inv_tok1', 'team_a', 'hash_xyz', 'viewer',
        'usr_inviter2', now() + interval '7 days')
    `);
    await expectViolation(
      `INSERT INTO invites (id, team_id, token_hash, target_role,
        invited_by_user_id, expires_at)
       VALUES ('inv_tok2', 'team_a', 'hash_xyz', 'admin',
        'usr_inviter2', now() + interval '7 days')`,
      'invites_token_hash_unique',
    );
  });

  it('DUA-222: web_session FK to users is enforced', async () => {
    await exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES ('usr_sess', 99996, 'session_user')
    `);
    // Valid insert.
    await exec(`
      INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
      VALUES ('ses_ok', 'usr_sess', 'sess_hash_1', now(), now() + interval '1 day')
    `);
    // Bad user FK.
    await expectViolation(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
       VALUES ('ses_bad', 'usr_nonexistent', 'sess_hash_2', now(), now() + interval '1 day')`,
      'web_sessions_user_id_users_id_fk',
    );
  });

  it('DUA-222: web_session token_hash is unique', async () => {
    await exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES ('usr_sess2', 99997, 'session_user2')
    `);
    await exec(`
      INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
      VALUES ('ses_h1', 'usr_sess2', 'sess_hash_uq', now(), now() + interval '1 day')
    `);
    await expectViolation(
      `INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at)
       VALUES ('ses_h2', 'usr_sess2', 'sess_hash_uq', now(), now() + interval '1 day')`,
      'web_sessions_token_hash_unique',
    );
  });

  it('DUA-222: all four tables, team_role enum, FKs, and indexes exist after migration', async () => {
    // Tables exist.
    for (const table of ['users', 'web_sessions', 'invites', 'memberships']) {
      const { rows } = await db.query(
        `SELECT tablename FROM pg_tables WHERE tablename = '${table}'`,
      );
      expect(rows, `table ${table} should exist`).toHaveLength(1);
    }
    // team_role enum type exists.
    const { rows: enumRows } = await db.query(
      `SELECT typname FROM pg_type WHERE typname = 'team_role'`,
    );
    expect(enumRows).toHaveLength(1);
    // Indexes exist.
    for (const idx of [
      'users_github_id_idx',
      'web_sessions_user_idx',
      'web_sessions_token_hash_idx',
      'invites_team_idx',
      'invites_token_hash_idx',
      'memberships_team_idx',
    ]) {
      const { rows: idxRows } = await db.query(
        `SELECT indexname FROM pg_indexes WHERE indexname = '${idx}'`,
      );
      expect(idxRows, `index ${idx} should exist`).toHaveLength(1);
    }
  });
});
