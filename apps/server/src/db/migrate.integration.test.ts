/**
 * Auto-migration on boot (cold-start) — against a real, disposable Postgres.
 *
 * Pins the fix for the M2 cold-start break: a fresh database volume comes up
 * with zero tables because no compose service ran migrations, so the first
 * sign-in / team creation failed at the database layer. runMigrations() must
 * take a genuinely empty database to the full current schema on its own.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise (no
 * mocked database, per project red line). Requires CREATE DATABASE rights
 * (true for the docker-compose 'teamem' superuser).
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbHandle } from './client.js';
import { runMigrations, resolveMigrationsDir } from './migrate.js';

const url = process.env['TEST_DATABASE_URL'];

describe('resolveMigrationsDir', () => {
  it('locates a drizzle folder that contains a journal', () => {
    const dir = resolveMigrationsDir();
    expect(dir).not.toBeNull();
  });
});

describe('runMigrations skip switch', () => {
  it('no-ops when TEAMEM_AUTO_MIGRATE=false without touching the db', async () => {
    const prev = process.env['TEAMEM_AUTO_MIGRATE'];
    process.env['TEAMEM_AUTO_MIGRATE'] = 'false';
    try {
      // A db handle that throws if any query is attempted — proves the skip
      // path returns before doing any work.
      const exploding = {
        $client: {
          query: () => {
            throw new Error('db should not be touched when auto-migrate is off');
          },
        },
      } as unknown as Parameters<typeof runMigrations>[0];
      await expect(runMigrations(exploding, () => {})).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['TEAMEM_AUTO_MIGRATE'];
      else process.env['TEAMEM_AUTO_MIGRATE'] = prev;
    }
  });
});

describe.skipIf(!url)('runMigrations takes an empty database to full schema (live Postgres)', () => {
  const dbName = `migrate_boot_${randomUUID().replace(/-/g, '')}`;
  let maintenance: Client;
  let targetUrl: string;
  let handle: ReturnType<typeof createDbHandle>;

  beforeAll(async () => {
    const base = new URL(url!);
    maintenance = new Client({ connectionString: base.toString() });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${dbName}"`);

    const targetUri = new URL(base.toString());
    targetUri.pathname = `/${dbName}`;
    targetUrl = targetUri.toString();
  });

  afterAll(async () => {
    if (handle) await handle.close();
    if (maintenance) {
      await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await maintenance.end();
    }
  });

  it('creates the core tables on a fresh volume', async () => {
    handle = createDbHandle(targetUrl);

    // Sanity: genuinely empty before migrating.
    const before = await handle.db.$client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(before.rows[0].n).toBe(0);

    await runMigrations(handle.db, () => {});

    // The tables the cold-start path depends on must now exist.
    const after = await handle.db.$client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(after.rows.map((r: { table_name: string }) => r.table_name));
    for (const t of ['users', 'web_sessions', 'teams', 'projects', 'memberships']) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it('is idempotent — a second run is a no-op', async () => {
    // Already migrated in the previous test; running again must not throw.
    await expect(runMigrations(handle.db, () => {})).resolves.toBeUndefined();
  });
});
