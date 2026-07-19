/**
 * pg-boss lifecycle — real-Postgres integration tests (M0-JOB-01).
 *
 * Runs only when TEST_DATABASE_URL points at a reachable Postgres; honestly
 * skipped otherwise — no mocked database or mocked queue, per project red line.
 * Each test isolates pg-boss into its own schema and drops it afterwards.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test:integration
 *
 * Proves, against real infrastructure:
 *   - pg-boss tables are created on start.
 *   - a job can be sent and received via the work handler.
 *   - clean stop tears down the connection pool.
 *   - the queue-policy settings are applied and observable.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPILE_QUEUE,
  createCompileQueue,
  DEFAULT_COMPILE_QUEUE_POLICY,
  type CompileJob,
} from './boss.js';
import { createDbHandle } from '../db/client.js';

const url = process.env['TEST_DATABASE_URL'];

/** Helper to return a fresh, non-shared pool for schema-cleanup after tests. */
function cleanupHandle() {
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  return createDbHandle(url);
}

describe.skipIf(!url)('pg-boss lifecycle (live Postgres)', () => {
  const schemas: string[] = [];

  afterEach(async () => {
    const handle = cleanupHandle();
    try {
      for (const schema of schemas.splice(0)) {
        await handle.db.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    } finally {
      await handle.close();
    }
  });

  function uniqueSchema(): string {
    const schema = `pgboss_test_${randomBytes(6).toString('hex')}`;
    schemas.push(schema);
    return schema;
  }

  it('start creates the pg-boss schema and job table', async () => {
    const schema = uniqueSchema();
    const queue = createCompileQueue(url!, { schema });

    await queue.start();
    try {
      // Verify the schema and its tables exist by querying information_schema.
      const handle = cleanupHandle();
      try {
        const { rows } = await handle.db.execute(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = '${schema}' AND table_name = 'job'`,
        );
        expect(rows).toHaveLength(1);
        expect((rows[0] as Record<string, unknown>).table_name).toBe('job');
      } finally {
        await handle.close();
      }
    } finally {
      await queue.stop();
    }
  });

  it('a job can be sent and received via the work handler', async () => {
    const schema = uniqueSchema();
    const queue = createCompileQueue(url!, { schema });

    await queue.start();
    try {
      const received: CompileJob[] = [];
      await queue.work(async (job) => {
        received.push(job);
      });

      const payload = { eventId: 'evt-test-1', projectId: 'prj-test' };
      const jobId = await queue.send(payload);
      expect(jobId).toBeTruthy();

      // Wait for the worker to pick up the job.
      const deadline = Date.now() + 20_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(received).toHaveLength(1);
      expect(received[0]!.id).toBe(jobId);
      expect(received[0]!.data).toEqual(payload);
    } finally {
      await queue.stop();
    }
  });

  it('stop tears down cleanly — a second stop is a no-op', async () => {
    const schema = uniqueSchema();
    const queue = createCompileQueue(url!, { schema });

    await queue.start();
    await queue.stop();
    // Second stop should not throw.
    await expect(queue.stop()).resolves.toBeUndefined();
  });

  it('queue-policy is applied: the created queue carries the explicit settings', async () => {
    const schema = uniqueSchema();
    const queue = createCompileQueue(url!, { schema });

    await queue.start();
    try {
      // Query the pg-boss queue table to verify the policy was applied.
      const handle = cleanupHandle();
      try {
        const { rows } = await handle.db.execute(
          `SELECT name, retry_limit, retry_delay, retry_backoff, expire_seconds
           FROM ${schema}.queue WHERE name = '${COMPILE_QUEUE}'`,
        );
        expect(rows).toHaveLength(1);
        const row = rows[0] as Record<string, unknown>;
        expect(row.name).toBe(COMPILE_QUEUE);
        expect(Number(row.retry_limit)).toBe(DEFAULT_COMPILE_QUEUE_POLICY.retryLimit);
        expect(Number(row.retry_delay)).toBe(DEFAULT_COMPILE_QUEUE_POLICY.retryDelay);
        expect(Boolean(row.retry_backoff)).toBe(DEFAULT_COMPILE_QUEUE_POLICY.retryBackoff);
        expect(Number(row.expire_seconds)).toBe(DEFAULT_COMPILE_QUEUE_POLICY.expireInSeconds);
      } finally {
        await handle.close();
      }
    } finally {
      await queue.stop();
    }
  });

  it('queue-policy overrides are merged on top of defaults', async () => {
    const schema = uniqueSchema();
    const overrideRetryLimit = 1;
    const queue = createCompileQueue(url!, {
      schema,
      queuePolicy: { retryLimit: overrideRetryLimit, retryBackoff: false },
    });

    await queue.start();
    try {
      const handle = cleanupHandle();
      try {
        const { rows } = await handle.db.execute(
          `SELECT retry_limit, retry_backoff, retry_delay
           FROM ${schema}.queue WHERE name = '${COMPILE_QUEUE}'`,
        );
        expect(rows).toHaveLength(1);
        const row = rows[0] as Record<string, unknown>;
        // Overrides take effect.
        expect(Number(row.retry_limit)).toBe(overrideRetryLimit);
        expect(Boolean(row.retry_backoff)).toBe(false);
        // Un-overridden field keeps the default.
        expect(Number(row.retry_delay)).toBe(DEFAULT_COMPILE_QUEUE_POLICY.retryDelay);
      } finally {
        await handle.close();
      }
    } finally {
      await queue.stop();
    }
  });

  it('boundary: sending to a stopped queue rejects', async () => {
    const schema = uniqueSchema();
    const queue = createCompileQueue(url!, { schema });

    await queue.start();
    await queue.stop();

    // After stop, the pool is closed — operations should fail or hang-then-fail.
    await expect(queue.send({ eventId: 'late' })).rejects.toThrow();
  });
});
