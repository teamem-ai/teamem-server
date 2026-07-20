/**
 * teamem server entrypoint / composition root (AGPL-3.0-only).
 *
 * Wires the real runtime — Postgres, pg-boss compile queue, HTTP server, and
 * (when TEAMEM_ALL_IN_ONE=true) an embedded compile worker — and hooks
 * SIGTERM/SIGINT to an ordered graceful shutdown. Startup failure exits non-zero
 * and leaves no orphaned resource behind.
 *
 * The topology decision and shutdown ordering live in ./composition-root.ts;
 * this file only supplies the concrete resources.
 */
import { loadRuntimeConfig } from './config/runtime.js';
import { startRuntime, type Runtime, type RuntimeStartup } from './composition-root.js';
import { createDbHandle } from './db/client.js';
import { createCompileQueue } from './queue/boss.js';
import { startEmbeddedWorker } from './worker/embedded.js';
import { startServer } from './server.js';
import { bootstrapMain } from './commands/bootstrap.js';
import { installShutdownHandlers } from './lifecycle.js';

/** Build the real startup factories over a validated runtime config. */
export function createRuntimeStartup(config: {
  allInOne: boolean;
  databaseUrl: string;
}): RuntimeStartup {
  const dbHandle = createDbHandle(config.databaseUrl);
  const queue = createCompileQueue(config.databaseUrl);

  return {
    async startDatabase() {
      // Prove connectivity so a dead database fails startup fast rather than
      // surfacing later as a mysterious query error.
      await dbHandle.db.execute('select 1');
      return { stop: () => dbHandle.close() };
    },
    async startQueue() {
      await queue.start();
      return { stop: () => queue.stop() };
    },
    async startHttpServer() {
      const server = startServer(undefined, { db: dbHandle.db, queue });
      // `serve()` from @hono/node-server starts listening asynchronously.
      // Wait for the server to be ready so an EADDRINUSE failure surfaces
      // during startup and not as an uncatchable background crash.
      await new Promise<void>((resolve, reject) => {
        if (server.listening) {
          resolve();
        } else {
          server.once('listening', resolve);
          server.once('error', reject);
        }
      });
      return {
        stop: () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      };
    },
    async startWorker() {
      return startEmbeddedWorker(queue);
    },
  };
}

/** Load config and start the runtime with real resources. */
export async function main(): Promise<Runtime> {
  const config = loadRuntimeConfig();
  return startRuntime(config, createRuntimeStartup(config), (msg) =>
    console.log(`[runtime] ${msg}`),
  );
}

async function bootstrap(): Promise<void> {
  let runtime: Runtime;
  try {
    runtime = await main();
  } catch (err) {
    console.error('teamem: startup failed:', err);
    process.exit(1);
    return;
  }

  console.log('teamem server ready');

  // Delegate shutdown to the shared lifecycle module so the server and the
  // worker share one signal-handling contract: single graceful teardown with
  // a force-exit safety net.
  installShutdownHandlers(async () => {
    await runtime.shutdown();
  });
}

// Only self-start when executed as the process entrypoint, so tests can import
// main()/createRuntimeStartup() without spawning a server or registering signal
// handlers.
const isMain =
  process.argv[1]?.endsWith('/index.js') || process.argv[1]?.endsWith('/index.ts');

if (isMain) {
  if (process.argv.includes('--bootstrap')) {
    void bootstrapMain();
  } else {
    void bootstrap();
  }
}
