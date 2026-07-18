/**
 * Database client lifecycle — real-Postgres integration tests (DUA-133).
 *
 * Runs only when TEST_DATABASE_URL points at a reachable Postgres; honestly
 * skipped otherwise — no mocked database, per project red line. Exercises
 * the startup connectivity check, bounded pool configuration, graceful
 * shutdown, injectable construction, and a fast (non-hanging) failure when
 * Postgres is unreachable.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
 *
 * CLI acceptance step 3 ("stop Postgres, rerun, confirm a clear failure
 * instead of a hang") is exercised by the last test below even while
 * TEST_DATABASE_URL is set and Postgres is running: it points a *separate*
 * connection at an unreachable port so the whole suite doesn't depend on
 * sabotaging the shared test database mid-run.
 */
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDbConnectivity, closeDb, createDb, type AppDb } from './client.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('createDb lifecycle (live Postgres)', () => {
  let db: AppDb | undefined;

  afterEach(async () => {
    if (db && !db.$client.ended) {
      await closeDb(db);
    }
    db = undefined;
  });

  it('constructs a typed Drizzle handle and passes the startup connectivity check', async () => {
    db = createDb(url!);
    await expect(checkDbConnectivity(db)).resolves.toBeUndefined();
  });

  it('applies bounded pool configuration when overrides are given', async () => {
    db = createDb(url!, { max: 3, connectionTimeoutMillis: 2_000 });
    expect(db.$client.options.max).toBe(3);
    expect(db.$client.options.connectionTimeoutMillis).toBe(2_000);
  });

  it('falls back to bounded (never unlimited) defaults when no override is given', async () => {
    db = createDb(url!);
    expect(db.$client.options.max).toBeGreaterThan(0);
    expect(db.$client.options.max).toBeLessThanOrEqual(50);
    expect(db.$client.options.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('shuts down gracefully: pool rejects further queries after close', async () => {
    db = createDb(url!);
    await checkDbConnectivity(db);
    await closeDb(db);
    expect(db.$client.ended).toBe(true);
    await expect(db.$client.query('SELECT 1')).rejects.toThrow();
  });

  it('construction is injectable: a caller-supplied Pool is used verbatim, not replaced', async () => {
    const injected = new Pool({ connectionString: url!, max: 1 });
    db = createDb(url!, { pool: injected });
    expect(db.$client).toBe(injected);
    await checkDbConnectivity(db);
  });

  it('security/boundary: connectivity check fails fast against an unreachable host instead of hanging', async () => {
    const unreachable = createDb('postgres://teamem:x@127.0.0.1:1/teamem', {
      connectionTimeoutMillis: 1_000,
    });
    const start = Date.now();
    await expect(checkDbConnectivity(unreachable)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5_000);
    await closeDb(unreachable);
  });
});
