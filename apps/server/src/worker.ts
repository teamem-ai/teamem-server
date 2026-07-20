/**
 * teamem compile worker process entrypoint — pg-boss consumer (AGPL-3.0-only).
 *
 * This is the process that `docker-compose.yml` starts with
 * `["node", "apps/server/dist/worker.js"]`. It shares the server's lifecycle
 * contract:
 *  - parse/validate config before reporting ready; a missing/illegal
 *    DATABASE_URL fails fast with a non-zero exit;
 *  - connect to the pg-boss compile queue and subscribe to consume compile
 *    jobs via the real F1 handler with atomic claim and lifecycle transitions;
 *  - shut down cleanly on SIGTERM/SIGINT: detach consumer, then stop queue;
 *  - never leave a dangling background promise.
 *
 * This is the same pg-boss consumer the all-in-one server embeds — only the
 * process boundary differs.
 */
import { loadRuntimeConfig } from './config/runtime.js';
import { parseServerEnv } from './config/env.js';
import { fatalStartup, installShutdownHandlers } from './lifecycle.js';
import { createCompileQueue } from './queue/boss.js';
import { createCompileJobHandler } from './queue/worker.js';
import { createDbHandle } from './db/client.js';
import { createLlmClient } from './llm/factory.js';

export async function runWorker(): Promise<void> {
  // The worker needs a database URL AND LLM configuration. Reuse the
  // server env parser which validates all required env vars.
  const config = loadRuntimeConfig();
  const env = parseServerEnv();

  // Select the first configured LLM provider for compilation.
  const llmProvider = env.llmProviders[0];
  if (!llmProvider) {
    throw new Error(
      'No LLM provider configured. Set one of TEAMEM_ANTHROPIC_API_KEY, ' +
      'TEAMEM_OPENAI_API_KEY, TEAMEM_OPENROUTER_API_KEY, or ' +
      'TEAMEM_OPENAI_COMPAT_BASE_URL + TEAMEM_OPENAI_COMPAT_API_KEY.',
    );
  }

  // Create a dedicated database handle for the worker's lifespan.
  const dbHandle = createDbHandle(config.databaseUrl);
  const db = dbHandle.db;

  // Build the LLM client from the first configured provider.
  const llm = createLlmClient(llmProvider);

  // pg-boss lives inside Postgres — the queue start verifies connectivity.
  const queue = createCompileQueue(config.databaseUrl, {
    onError: (err) => console.error('[worker] pg-boss error:', err),
  });

  await queue.start();
  await queue.work(createCompileJobHandler({ db, llm }));

  installShutdownHandlers(async () => {
    await queue.offWork();
    await queue.stop();
    await dbHandle.close();
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
