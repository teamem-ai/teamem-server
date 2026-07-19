/**
 * All-in-one lifecycle — real Postgres + real pg-boss (M0-PLAT-06).
 *
 * Runs only when TEST_DATABASE_URL points at a reachable Postgres; honestly
 * skipped otherwise — no mocked database or mocked queue, per project red line.
 * Each test isolates pg-boss into its own schema and drops it afterwards.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test:integration
 *
 * Proves, against real infrastructure:
 *   - allInOne=true  → exactly one embedded worker, a submitted job runs once.
 *   - allInOne=false → no embedded consumer, a submitted job is never processed.
 *   - shutdown tears down in order: worker → queue → HTTP server → database.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompileQueue, type CompileJob } from './queue/boss.js';
import { createDbHandle } from './db/client.js';
import { startEmbeddedWorker } from './worker/embedded.js';
import { startRuntime, type Runtime, type RuntimeStartup } from './composition-root.js';
import { startServer } from './server.js';

const url = process.env['TEST_DATABASE_URL'];

interface Harness {
  runtime: Runtime;
  queue: ReturnType<typeof createCompileQueue>;
  processed: string[];
  stopLog: string[];
}

describe.skipIf(!url)('all-in-one lifecycle (live Postgres + pg-boss)', () => {
  const schemas: string[] = [];

  afterEach(async () => {
    // Drop each test's pg-boss schema on a fresh connection (the runtime closed
    // its own during shutdown).
    const handle = createDbHandle(url!);
    try {
      for (const schema of schemas.splice(0)) {
        await handle.db.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    } finally {
      await handle.close();
    }
  });

  async function buildHarness(allInOne: boolean): Promise<Harness> {
    const schema = `pgboss_test_${randomBytes(6).toString('hex')}`;
    schemas.push(schema);

    const dbHandle = createDbHandle(url!);
    const queue = createCompileQueue(url!, { schema });
    const processed: string[] = [];
    const stopLog: string[] = [];

    const startup: RuntimeStartup = {
      async startDatabase() {
        await dbHandle.db.execute('select 1');
        return { stop: () => dbHandle.close() };
      },
      async startQueue() {
        await queue.start();
        return { stop: () => queue.stop() };
      },
      async startHttpServer() {
        const server = startServer({ port: 0 }); // ephemeral port
        return {
          stop: () =>
            new Promise<void>((resolve, reject) => {
              server.close((err) => (err ? reject(err) : resolve()));
            }),
        };
      },
      async startWorker() {
        return startEmbeddedWorker(queue, async (job: CompileJob) => {
          processed.push(job.id);
        });
      },
    };

    const runtime = await startRuntime({ allInOne }, startup, (msg) => {
      if (msg.startsWith('stopping ')) stopLog.push(msg.replace('stopping ', ''));
    });

    return { runtime, queue, processed, stopLog };
  }

  it(
    'allInOne=true embeds one worker that processes a submitted job exactly once',
    async () => {
      const { runtime, queue, processed, stopLog } = await buildHarness(true);
      expect(runtime.workerCount).toBe(1);

      const jobId = await queue.send({ eventId: 'evt-1' });
      expect(jobId).toBeTruthy();

      // Wait for the embedded worker to claim and run the job.
      const deadline = Date.now() + 20_000;
      while (processed.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Give any (erroneous) second delivery a chance to show up.
      await new Promise((r) => setTimeout(r, 1_000));

      expect(processed).toEqual([jobId]);

      await runtime.shutdown();
      expect(stopLog).toEqual(['worker', 'queue', 'httpServer', 'database']);
    },
    30_000,
  );

  it(
    'allInOne=false embeds no worker, so a submitted job is never processed',
    async () => {
      const { runtime, queue, processed, stopLog } = await buildHarness(false);
      expect(runtime.workerCount).toBe(0);

      await queue.send({ eventId: 'evt-2' });

      // No consumer exists in-process; wait well past a poll interval and
      // confirm nothing consumed it.
      await new Promise((r) => setTimeout(r, 4_000));
      expect(processed).toEqual([]);

      await runtime.shutdown();
      // No worker started, so shutdown skips it.
      expect(stopLog).toEqual(['queue', 'httpServer', 'database']);
    },
    30_000,
  );
});
