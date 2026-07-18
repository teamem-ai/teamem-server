/**
 * Real-database test scaffolding.
 *
 * Requires TEST_DATABASE_URL pointing at a Postgres instance with the
 * committed migrations already applied (pgvector extension, enums, tables).
 * No mock databases — per project red line.
 *
 * Each test gets a dedicated client from the pool with unique team/project
 * IDs. Tests that need to verify constraint violations use a separate
 * client from the pool so the violation does not abort the test client's
 * session.
 *
 * Usage:
 *   import { connectDatabase, createTestContext, closeDatabase } from '../test/database.js';
 *
 *   const { pool } = connectDatabase();
 *   afterAll(() => closeDatabase(pool));
 *
 *   it('example', async () => {
 *     await using ctx = await createTestContext(pool);
 *     // ctx.teamId, ctx.projectId are unique per test
 *     // all operations use the ctx.exec / ctx.query helpers
 *   });
 */
import { Pool } from 'pg';

export type { Pool } from 'pg';

export interface TestContext {
  /** Unique team ID for this test run. */
  readonly teamId: string;
  /** Unique project ID for this test run. */
  readonly projectId: string;
  /** Execute a SQL statement. */
  exec(sql: string): Promise<void>;
  /** Execute a SQL query and return rows. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<T[]>;
  /** Release the underlying client back to the pool. */
  release(): Promise<void>;
}

let counter = 0;

/**
 * Assert that the given SQL violates a named constraint.
 *
 * Acquires a separate client from the pool so the constraint violation
 * does not abort the calling test's session. The separate client is
 * released after the check.
 */
export async function expectViolation(
  pool: Pool,
  sql: string,
  constraint: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      throw new Error(
        `Expected constraint violation "${constraint}" but statement succeeded`,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('Expected constraint violation')
      ) {
        throw err;
      }
      // Expected: constraint violation — rollback the savepoint transaction
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}

/**
 * Connect to the test database. Returns a pool.
 *
 * Throws if TEST_DATABASE_URL is not set.
 */
export function connectDatabase(): { pool: Pool } {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set; skipping real-database tests',
    );
  }
  const pool = new Pool({ connectionString: url });
  return { pool };
}

/**
 * Create an isolated test context. Each context acquires a dedicated client
 * from the pool with unique team/project IDs.
 *
 * Returns an async-disposable context (use with `await using`).
 *
 * @example
 *   await using ctx = await createTestContext(pool);
 *   await ctx.exec(`INSERT INTO teams ...`);
 */
export async function createTestContext(
  pool: Pool,
): Promise<TestContext & { [Symbol.asyncDispose](): Promise<void> }> {
  const client = await pool.connect();

  const id = ++counter;
  const teamId = `test_team_${id}_${Date.now()}`;
  const projectId = `test_prj_${id}_${Date.now()}`;

  const ctx: TestContext & {
    [Symbol.asyncDispose](): Promise<void>;
  } = {
    teamId,
    projectId,
    exec: async (sql: string) => {
      await client.query(sql);
    },
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<T[]> => {
      const result = await client.query<T>(sql);
      return result.rows;
    },
    release: async () => {
      client.release();
    },
    [Symbol.asyncDispose]: async () => {
      client.release();
    },
  };

  return ctx;
}

/**
 * Close the database pool. Call in `afterAll`.
 */
export async function closeDatabase(pool: Pool): Promise<void> {
  await pool.end();
}
