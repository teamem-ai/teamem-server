/**
 * Existing-data migration counterexample (DUA-129 acceptance review issue 1):
 * migration 0001 must upgrade a database that already has 0000-shape rows,
 * not just a fresh empty one. Reproduces the exact failure the reviewer
 * found (NOT NULL column added with no backfill) as a permanent regression
 * check, against a real, disposable Postgres database.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise — no
 * mocked database, per project red line. Requires the connecting role to be
 * able to CREATE DATABASE (true for the docker-compose 'teamem' superuser).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['TEST_DATABASE_URL'];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(__dirname, '../../drizzle');

/** Applies a drizzle-kit SQL file statement-by-statement (autocommit each —
 * mirrors `psql`'s default behavior, and avoids node-postgres's simple-query
 * protocol implicitly wrapping the whole file in one transaction block). */
async function runSqlFile(client: Client, file: string): Promise<void> {
  const contents = readFileSync(path.join(drizzleDir, file), 'utf8');
  const statements = contents
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await client.query(statement);
  }
}

describe.skipIf(!url)('migration 0001 upgrades an existing 0000 database (live Postgres)', () => {
  const dbName = `migration_check_${randomUUID().replace(/-/g, '')}`;
  let maintenance: Client;
  let target: Client;
  let targetUrl: string;

  beforeAll(async () => {
    const base = new URL(url!);
    maintenance = new Client({ connectionString: base.toString() });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${dbName}"`);

    const targetUri = new URL(base.toString());
    targetUri.pathname = `/${dbName}`;
    targetUrl = targetUri.toString();
    target = new Client({ connectionString: targetUrl });
    await target.connect();

    await runSqlFile(target, '0000_chilly_the_stranger.sql');

    // Real pre-migration (0000-shape) data: no connector_kind/provider_kind
    // columns exist yet, exactly like a live self-hosted deployment.
    await target.query(`
      INSERT INTO teams (id, name) VALUES ('team_legacy', 'Legacy');
      INSERT INTO projects (id, team_id, name) VALUES ('prj_legacy', 'team_legacy', 'Legacy Project');
      INSERT INTO principals (id, team_id, kind, provider, provider_user_id, display_login)
        VALUES ('pri_legacy', 'team_legacy', 'human', 'github', '42', 'octocat');
      INSERT INTO events (id, team_id, project_id, channel, kind, delivery_id, item_key,
        external_id, actor_provenance, occurred_at, occurred_at_provenance, payload,
        payload_bytes, payload_hash, payload_schema_version, envelope_version)
      VALUES ('evt_legacy', 'team_legacy', 'prj_legacy', 'cli', 'cli_init', 'dk-legacy',
        'root', 'x', 'unknown', now(), 'server', '{}', 2, 'h1', 1, 1);
    `);
  });

  afterAll(async () => {
    await target.end();
    await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await maintenance.end();
  });

  it('applies cleanly and backfills connector_kind/provider_kind for pre-existing rows', async () => {
    await expect(runSqlFile(target, '0001_close_generic_connector_persistence_seam.sql')).resolves.not.toThrow();

    const events = await target.query(
      `SELECT connector_kind, channel FROM events WHERE id = 'evt_legacy'`,
    );
    expect(events.rows[0]).toMatchObject({ connector_kind: 'cli', channel: 'cli' });

    const principals = await target.query(
      `SELECT provider_kind, provider FROM principals WHERE id = 'pri_legacy'`,
    );
    expect(principals.rows[0]).toMatchObject({ provider_kind: 'github', provider: 'github' });
  });

  it('both idempotency indexes survive the upgrade and enforce the hardened tuple', async () => {
    const indexes = await target.query(
      `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('events_idempotency_uq', 'principals_identity_uq')`,
    );
    expect(indexes.rows.map((r) => r['indexname']).sort()).toEqual([
      'events_idempotency_uq',
      'principals_identity_uq',
    ]);

    // Columns are genuinely NOT NULL post-upgrade, not just nullable-with-data.
    await expect(
      target.query(
        `INSERT INTO events (id, team_id, project_id, channel, kind, delivery_id, item_key,
          external_id, actor_provenance, occurred_at, occurred_at_provenance, payload,
          payload_bytes, payload_hash, payload_schema_version, envelope_version)
         VALUES ('evt_no_connector_kind', 'team_legacy', 'prj_legacy', 'cli', 'cli_init',
          'dk-2', 'root', 'x', 'unknown', now(), 'server', '{}', 2, 'h2', 1, 1)`,
      ),
    ).rejects.toThrow(/null value in column "connector_kind"/);
  });
});
