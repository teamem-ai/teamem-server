/**
 * Database test scaffolding verification.
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres with the initial
 * migration applied; honestly skipped otherwise — no mock database.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   psql < apps/server/drizzle/0000_*.sql
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Pool,
  closeDatabase,
  connectDatabase,
  createTestContext,
  expectViolation,
} from './database.js';

const url = process.env['TEST_DATABASE_URL'];

/** FK-safe delete order for test cleanup. */
const CLEANUP_ORDER: Array<[table: string, where: string]> = [
  ['job_events', 'team_id'],
  ['jobs', 'team_id'],
  ['concept_paths', 'team_id'],
  ['concept_evidence', 'team_id'],
  ['concept_contributors', 'team_id'],
  ['concepts', 'team_id'],
  ['events', 'team_id'],
  ['api_keys', 'team_id'],
  ['principals', 'team_id'],
  ['projects', 'team_id'],
  ['teams', 'id'],
];

async function cleanup(ctx: { exec: (sql: string) => Promise<void>; teamId: string }) {
  for (const [table, col] of CLEANUP_ORDER) {
    await ctx.exec(`DELETE FROM ${table} WHERE ${col} = '${ctx.teamId}'`);
  }
}

describe.skipIf(!url)('database test scaffolding (live Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  describe('success path', () => {
    it('creates and reads a team and project', async () => {
      await using ctx = await createTestContext(pool);

      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'Test Team')
      `);
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${ctx.projectId}', '${ctx.teamId}', 'Test Project')
      `);

      const rows = await ctx.query<{ id: string }>(
        `SELECT id FROM teams WHERE id = '${ctx.teamId}'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(ctx.teamId);

      const projects = await ctx.query<{ id: string }>(
        `SELECT id FROM projects WHERE id = '${ctx.projectId}'`,
      );
      expect(projects).toHaveLength(1);
      expect(projects[0]!.id).toBe(ctx.projectId);

      await cleanup(ctx);
    });

    it('creates a full entity chain: team, project, principal, concept, evidence, path, contributor', async () => {
      await using ctx = await createTestContext(pool);

      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'T')
      `);
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${ctx.projectId}', '${ctx.teamId}', 'P')
      `);
      await ctx.exec(`
        INSERT INTO principals (id, team_id, kind, provider, provider_user_id,
          provider_kind)
        VALUES ('pri_test', '${ctx.teamId}', 'human', 'github', '12345',
          'github')
      `);
      const conceptUuid = randomUUID();
      await ctx.exec(`
        INSERT INTO concepts (uuid, team_id, project_id, schema_version, type,
          status, confidence, title, body, first_seen, last_confirmed)
        VALUES ('${conceptUuid}', '${ctx.teamId}',
          '${ctx.projectId}', 1, 'service', 'active', 'high', 'Test',
          'body', now(), now())
      `);
      await ctx.exec(`
        INSERT INTO concept_evidence (team_id, project_id, concept_uuid, kind,
          ref, at)
        VALUES ('${ctx.teamId}', '${ctx.projectId}',
          '${conceptUuid}', 'manual', 'test-ref',
          now())
      `);
      await ctx.exec(`
        INSERT INTO concept_paths (team_id, project_id, concept_uuid, path,
          is_current)
        VALUES ('${ctx.teamId}', '${ctx.projectId}',
          '${conceptUuid}', 'services/test', true)
      `);
      await ctx.exec(`
        INSERT INTO concept_contributors (team_id, project_id, concept_uuid,
          principal_id)
        VALUES ('${ctx.teamId}', '${ctx.projectId}',
          '${conceptUuid}', 'pri_test')
      `);

      const concepts = await ctx.query<{ title: string }>(
        `SELECT title FROM concepts WHERE team_id = '${ctx.teamId}'`,
      );
      expect(concepts).toHaveLength(1);
      expect(concepts[0]!.title).toBe('Test');

      await cleanup(ctx);
    });
  });

  describe('failure path — FK constraints', () => {
    it('rejects cross-tenant project mismatch (events_project_fk)', async () => {
      await using ctx = await createTestContext(pool);
      await using ctx2 = await createTestContext(pool);

      // Create a legitimate team and project in ctx
      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'A')
      `);
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${ctx.projectId}', '${ctx.teamId}', 'PA')
      `);

      // Create a foreign team in ctx2
      await ctx2.exec(`INSERT INTO teams (id, name) VALUES ('${ctx2.teamId}', 'B')`);

      // Cross-tenant: ctx2's team claiming ctx's project → rejected
      await expectViolation(
        pool,
        `INSERT INTO events (id, team_id, project_id, channel, kind,
          delivery_id, item_key, external_id, actor_provenance, occurred_at,
          occurred_at_provenance, payload, payload_bytes, payload_hash,
          payload_schema_version, envelope_version, connector_kind)
        VALUES ('evt_cross', '${ctx2.teamId}', '${ctx.projectId}', 'cli',
          'cli_init', 'del_cross', 'root', 'x', 'unknown', now(), 'server',
          '{}', 2, 'h2', 1, 1, 'cli')`,
        'events_project_fk',
      );

      await cleanup(ctx);
      await cleanup(ctx2);
    });
  });

  describe('failure path — unique constraints', () => {
    it('rejects duplicate event idempotency (events_idempotency_uq)', async () => {
      await using ctx = await createTestContext(pool);

      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'A')
      `);
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${ctx.projectId}', '${ctx.teamId}', 'PA')
      `);
      await ctx.exec(`
        INSERT INTO events (id, team_id, project_id, channel, kind,
          delivery_id, item_key, external_id, actor_provenance, occurred_at,
          occurred_at_provenance, payload, payload_bytes, payload_hash,
          payload_schema_version, envelope_version, connector_kind)
        VALUES ('evt1', '${ctx.teamId}', '${ctx.projectId}', 'cli',
          'cli_init', 'del1', 'root', 'x', 'unknown', now(), 'server',
          '{}', 2, 'h1', 1, 1, 'cli')
      `);

      // Same (project, channel, connector_kind, delivery_id, item_key) → rejected
      await expectViolation(
        pool,
        `INSERT INTO events (id, team_id, project_id, channel, kind,
          delivery_id, item_key, external_id, actor_provenance, occurred_at,
          occurred_at_provenance, payload, payload_bytes, payload_hash,
          payload_schema_version, envelope_version, connector_kind)
        VALUES ('evt1_dup', '${ctx.teamId}', '${ctx.projectId}', 'cli',
          'cli_init', 'del1', 'root', 'x2', 'unknown', now(), 'server',
          '{}', 2, 'h2', 1, 1, 'cli')`,
        'events_idempotency_uq',
      );

      await cleanup(ctx);
    });
  });

  describe('failure path — CHECK constraints', () => {
    it('rejects api_keys all_projects=false + project_id=null (N6)', async () => {
      await using ctx = await createTestContext(pool);

      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'A')
      `);

      await expectViolation(
        pool,
        `INSERT INTO api_keys (id, team_id, name, token_hash, scopes,
          all_projects)
        VALUES ('key_bad', '${ctx.teamId}', 'k', 'h_bad', '{read}', false)`,
        'api_keys_least_privilege_ck',
      );

      await cleanup(ctx);
    });

    it('rejects read:payload without read scope (N7)', async () => {
      await using ctx = await createTestContext(pool);

      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'A')
      `);
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${ctx.projectId}', '${ctx.teamId}', 'PA')
      `);

      await expectViolation(
        pool,
        `INSERT INTO api_keys (id, team_id, project_id, name, token_hash,
          scopes, all_projects)
        VALUES ('key_bad2', '${ctx.teamId}', '${ctx.projectId}', 'k',
          'h_bad2', '{read:payload}', false)`,
        'api_keys_scope_superset_ck',
      );

      await cleanup(ctx);
    });
  });

  describe('boundary — job idempotency scoped by kind (N1)', () => {
    it('same key + same kind → rejected; same key + different kind → legal', async () => {
      await using ctx = await createTestContext(pool);

      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'A')
      `);
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${ctx.projectId}', '${ctx.teamId}', 'PA')
      `);

      const job = (id: string, kind: string, key: string) => `
        INSERT INTO jobs (id, team_id, project_id, kind, initiated_by_kind,
          idempotency_key, idempotency_request_hash, event_count)
        VALUES ('${id}', '${ctx.teamId}', '${ctx.projectId}', '${kind}',
          'credential', '${key}', 'rh', 1)`;

      const jobId1 = randomUUID();
      const jobId2 = randomUUID();
      const jobId3 = randomUUID();

      await ctx.exec(job(jobId1, 'ingest_batch', 'ik1'));

      // Same key + same kind → rejected
      await expectViolation(pool, job(jobId2, 'ingest_batch', 'ik1'), 'jobs_idempotency_uq');

      // Same key + different kind → legal
      await ctx.exec(job(jobId3, 'compilation', 'ik1'));

      await cleanup(ctx);
    });
  });

  describe('boundary — concept path namespace (N5)', () => {
    it('one namespace for current paths and historical aliases', async () => {
      await using ctx = await createTestContext(pool);

      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'A')
      `);
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${ctx.projectId}', '${ctx.teamId}', 'PA')
      `);

      const uuid1 = randomUUID();
      const uuid2 = randomUUID();

      await ctx.exec(`
        INSERT INTO concepts (uuid, team_id, project_id, schema_version, type,
          status, confidence, title, body, first_seen, last_confirmed)
        VALUES
          ('${uuid1}', '${ctx.teamId}', '${ctx.projectId}', 1, 'service',
            'active', 'high', 'A', '', now(), now()),
          ('${uuid2}', '${ctx.teamId}', '${ctx.projectId}', 1, 'service',
            'active', 'high', 'B', '', now(), now())
      `);
      await ctx.exec(`
        INSERT INTO concept_paths (team_id, project_id, concept_uuid, path,
          is_current)
        VALUES ('${ctx.teamId}', '${ctx.projectId}', '${uuid1}',
          'services/a', true)
      `);

      // Different concept, same path (alias) → rejected (shared namespace)
      await expectViolation(
        pool,
        `INSERT INTO concept_paths (team_id, project_id, concept_uuid, path,
          is_current)
        VALUES ('${ctx.teamId}', '${ctx.projectId}', '${uuid2}',
          'services/a', false)`,
        'concept_paths_namespace_uq',
      );

      // Same concept, two current paths → rejected (one current per concept)
      await expectViolation(
        pool,
        `INSERT INTO concept_paths (team_id, project_id, concept_uuid, path,
          is_current)
        VALUES ('${ctx.teamId}', '${ctx.projectId}', '${uuid1}',
          'services/a2', true)`,
        'concept_paths_current_uq',
      );

      await cleanup(ctx);
    });
  });

  describe('boundary — job_events tenant consistency', () => {
    it('job_events FK binds job and event to the same tenant', async () => {
      await using ctx = await createTestContext(pool);

      await ctx.exec(`
        INSERT INTO teams (id, name) VALUES ('${ctx.teamId}', 'A')
      `);
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${ctx.projectId}', '${ctx.teamId}', 'PA')
      `);

      // Create a second project in the same team
      const projectId2 = `${ctx.projectId}_2`;
      await ctx.exec(`
        INSERT INTO projects (id, team_id, name)
        VALUES ('${projectId2}', '${ctx.teamId}', 'PA2')
      `);

      // Create an event in project 1
      await ctx.exec(`
        INSERT INTO events (id, team_id, project_id, channel, kind,
          delivery_id, item_key, external_id, actor_provenance, occurred_at,
          occurred_at_provenance, payload, payload_bytes, payload_hash,
          payload_schema_version, envelope_version, connector_kind)
        VALUES ('evt_je', '${ctx.teamId}', '${ctx.projectId}', 'cli',
          'cli_init', 'del_je', 'root', 'x', 'unknown', now(), 'server',
          '{}', 2, 'h1', 1, 1, 'cli')
      `);

      // Create a job in project 2
      const jobUuid = randomUUID();
      await ctx.exec(`
        INSERT INTO jobs (id, team_id, project_id, kind, initiated_by_kind,
          event_count)
        VALUES ('${jobUuid}', '${ctx.teamId}',
          '${projectId2}', 'ingest_event', 'credential', 1)
      `);

      // job_events claiming event from project 1 for a job in project 2 → rejected
      await expectViolation(
        pool,
        `INSERT INTO job_events (team_id, project_id, job_id, event_id)
        VALUES ('${ctx.teamId}', '${projectId2}',
          '${jobUuid}', 'evt_je')`,
        'job_events_event_fk',
      );

      await cleanup(ctx);
    });
  });
});
