/**
 * Real-database test scaffolding.
 *
 * Requires TEST_DATABASE_URL pointing at a Postgres instance with the
 * committed migrations already applied (pgvector extension, enums, tables).
 * No mock databases — per project red line.
 *
 * Each test runs inside a transaction that is automatically rolled back
 * when the context is disposed, giving leak-free cleanup even on test
 * failure. Constraint-violation assertions (expectViolation) use Postgres
 * savepoints on the SAME connection so they can see uncommitted seed data
 * while remaining isolated from the outer transaction.
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
 *     // all changes are rolled back when the context goes out of scope
 *   });
 */
import { Pool } from 'pg';

export type { Pool } from 'pg';

export interface TestContext {
  readonly teamId: string;
  readonly projectId: string;
  exec(sql: string): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<T[]>;
}

let counter = 0;

/**
 * Assert that the given SQL violates a named constraint.
 *
 * Runs on the test's own connection so it sees uncommitted seed data.
 * Uses a Postgres savepoint to isolate the violation: if the SQL fails
 * (expected), ROLLBACK TO SAVEPOINT resets the transaction state; if it
 * succeeds (unexpected), the savepoint is released and an error is thrown.
 * Verifies the error message contains the expected constraint name.
 */
export async function expectViolation(
  ctx: TestContext,
  sql: string,
  constraint: string,
): Promise<void> {
  await ctx.exec('SAVEPOINT sp_violation');
  let released = false;
  try {
    await ctx.exec(sql);
    // Statement succeeded when it should have violated — release savepoint
    await ctx.exec('RELEASE SAVEPOINT sp_violation');
    released = true;
    throw new Error(
      `Expected constraint violation "${constraint}" but statement succeeded`,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Expected constraint violation')) {
      throw err;
    }
    // Constraint violation — rollback the savepoint to recover transaction state
    if (!released) {
      await ctx.exec('ROLLBACK TO SAVEPOINT sp_violation');
    }
    if (!(err instanceof Error) || !err.message.includes(constraint)) {
      throw new Error(
        `Expected constraint "${constraint}" but got: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  return { pool: new Pool({ connectionString: url }) };
}

/**
 * Create an isolated test context.
 *
 * All operations run inside a transaction that is automatically rolled
 * back when the context is disposed (via `await using` or
 * `Symbol.asyncDispose`). This guarantees leak-free cleanup irrespective
 * of test success or failure.
 */
export async function createTestContext(
  pool: Pool,
): Promise<TestContext & { [Symbol.asyncDispose](): Promise<void> }> {
  const client = await pool.connect();
  await client.query('BEGIN');

  const id = ++counter;
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const teamId = `test_team_${id}_${suffix}`;
  const projectId = `test_prj_${id}_${suffix}`;

  return {
    teamId,
    projectId,
    exec: async (sql: string) => {
      await client.query(sql);
    },
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<T[]> => {
      const { rows } = await client.query<T>(sql);
      return rows;
    },
    [Symbol.asyncDispose]: async () => {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Close the database pool. Call in `afterAll`.
 */
export async function closeDatabase(pool: Pool): Promise<void> {
  await pool.end();
}
