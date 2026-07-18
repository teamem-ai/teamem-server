/**
 * teamem compile worker process entrypoint — pg-boss consumer (AGPL-3.0-only).
 *
 * This is the process that `docker-compose.yml` starts with
 * `["node", "apps/server/dist/worker.js"]`. It shares the server's lifecycle
 * contract:
 *  - parse/validate config and verify database connectivity before reporting
 *    ready; a missing/illegal DATABASE_URL or unreachable Postgres fails fast
 *    with a non-zero exit (pg-boss lives inside Postgres — no database, no
 *    worker);
 *  - shut down cleanly on SIGTERM/SIGINT;
 *  - never leave a dangling background promise.
 *
 * The pg-boss queue consumer (F1/F2 compile jobs) lands with the compile
 * tasks. Until then the process connects, holds its database handle open, and
 * waits for signals — it does NOT fabricate compile results or invent jobs.
 * The keep-alive timer below is the honest placeholder that keeps the loop
 * alive; it is replaced by the real queue subscription and is cleared on
 * shutdown.
 */
import { parseServerEnv } from './config/env.js';
import { checkDbConnectivity, closeDb, createDb } from './db/client.js';
import { fatalStartup, installShutdownHandlers } from './lifecycle.js';

const IDLE_HEARTBEAT_MS = 60_000;

export async function runWorker(): Promise<void> {
  const env = parseServerEnv();
  const db = createDb(env.databaseUrl);

  await checkDbConnectivity(db);

  // Keep the event loop alive until a shutdown signal. A ref'd timer is the
  // honest placeholder for the not-yet-wired pg-boss subscription; it does no
  // work beyond holding the process open.
  const heartbeat = setInterval(() => {}, IDLE_HEARTBEAT_MS);

  installShutdownHandlers(async () => {
    clearInterval(heartbeat);
    await closeDb(db);
  });

  console.log(
    'teamem worker ready — database connected; awaiting the pg-boss compile queue (not wired yet)',
  );
}

// Run only when executed as the process entry, not when imported by a test.
const isMain =
  process.argv[1]?.endsWith('/worker.js') || process.argv[1]?.endsWith('/worker.ts');

if (isMain) {
  runWorker().catch((err: unknown) => fatalStartup(err));
}
