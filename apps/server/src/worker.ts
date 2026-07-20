/**
 * teamem compile worker process entrypoint — pg-boss consumer (AGPL-3.0-only).
 *
 * This is the process that `docker-compose.yml` starts with
 * `["node", "apps/server/dist/worker.js"]`. It shares the server's lifecycle
 * contract:
 *  - parse/validate config before reporting ready; a missing/illegal
 *    DATABASE_URL fails fast with a non-zero exit;
 *  - connect to the pg-boss compile queue and subscribe to consume compile
 *    jobs (F1/F2 handlers land with the compile tasks; until then the no-op
 *    acknowledge handler is wired);
 *  - shut down cleanly on SIGTERM/SIGINT: detach consumer, then stop queue;
 *  - never leave a dangling background promise.
 *
 * This is the same pg-boss consumer the all-in-one server embeds — only the
 * process boundary differs.
 */
import { loadRuntimeConfig } from './config/runtime.js';
import { fatalStartup, installShutdownHandlers } from './lifecycle.js';
import { createCompileQueue } from './queue/boss.js';
import { acknowledgeCompileJob } from './worker/embedded.js';

export async function runWorker(): Promise<void> {
  // The worker only needs a database URL; reuse the runtime config parser
  // which validates DATABASE_URL without requiring the full server env
  // (TEAMEM_HOST, TEAMEM_PORT, GitHub keys, etc. are irrelevant here).
  const config = loadRuntimeConfig();

  // pg-boss lives inside Postgres — the queue start verifies connectivity.
  const queue = createCompileQueue(config.databaseUrl, {
    onError: (err) => console.error('[worker] pg-boss error:', err),
  });

  await queue.start();
  await queue.work(acknowledgeCompileJob);

  installShutdownHandlers(async () => {
    await queue.offWork();
    await queue.stop();
  });

  console.log(
    'teamem worker ready — pg-boss compile queue consumer attached',
  );
}

// Run only when executed as the process entry, not when imported by a test.
const isMain =
  process.argv[1]?.endsWith('/worker.js') || process.argv[1]?.endsWith('/worker.ts');

if (isMain) {
  runWorker().catch((err: unknown) => fatalStartup(err));
}
