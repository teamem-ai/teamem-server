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
import { parseServerEnv } from './config/env.js';
import { startRuntime, type Runtime, type RuntimeStartup } from './composition-root.js';
import { createDbHandle } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createCompileQueue } from './queue/boss.js';
import { startEmbeddedWorker } from './worker/embedded.js';
import { createCompileJobHandler } from './queue/worker.js';
import { startStaleJobReclaimer } from './queue/stale-job-reclaimer.js';
import { createTeamLlmResolver } from './llm/resolve-team-llm.js';
import { createEmbeddingClient } from './llm/embedding/factory.js';
import { startServer } from './server.js';
import type { GitHubOAuthConfig } from './auth/oauth-github.js';
import { bootstrapMain } from './commands/bootstrap.js';
import { installShutdownHandlers } from './lifecycle.js';
import { GitHubConnector } from './connectors/github/connector.js';
import { registerConnector } from './connectors/registry.js';
import { createGitHubAppCredentialsProvider } from './connectors/github/app-credentials.js';
import { createGitHubApiClient, type GitHubApiClient } from './connectors/github/app-api-client.js';

/** Build the real startup factories over a validated runtime config. */
export function createRuntimeStartup(config: {
  allInOne: boolean;
  databaseUrl: string;
}): RuntimeStartup {
  const dbHandle = createDbHandle(config.databaseUrl);
  const queue = createCompileQueue(config.databaseUrl);

  // Resolve LLM config from the environment. This is the fallback for teams
  // that have not saved a provider in Settings → LLM; per-team BYO config
  // (resolved at job time) takes precedence. The embedding client here serves
  // the HTTP read path (search / MCP); the compile worker resolves its own.
  const env = parseServerEnv();
  const llmProvider = env.llmProviders[0];
  const embeddingClient =
    llmProvider ? createEmbeddingClient(llmProvider) : null;

  // GitHub App REST API client (installation repo list for Settings →
  // Ingestion). Needs the three credentials that let us mint an installation
  // token; OAuth client id/secret are irrelevant to this call, so this is a
  // narrower gate than githubAppConfigured.
  let githubApiClient: GitHubApiClient | undefined;
  if (env.github?.appId && env.github?.installationId && env.github?.privateKey) {
    const credentialsProvider = createGitHubAppCredentialsProvider({
      appId: env.github.appId,
      installationId: env.github.installationId,
      privateKey: env.github.privateKey,
    });
    githubApiClient = createGitHubApiClient(credentialsProvider);
  }

  return {
    async startDatabase() {
      // Prove connectivity so a dead database fails startup fast rather than
      // surfacing later as a mysterious query error.
      await dbHandle.db.execute('select 1');
      // Apply pending schema migrations before anything serves traffic. A
      // fresh Postgres volume has no tables until this runs, and every
      // sign-in / write would otherwise fail at the database layer. Runs
      // only in the server process (the worker never migrates); idempotent
      // and skippable via TEAMEM_AUTO_MIGRATE=false.
      await runMigrations(dbHandle.db, (m) => console.log(`[runtime] ${m}`));
      return { stop: () => dbHandle.close() };
    },
    async startQueue() {
      await queue.start();
      return { stop: () => queue.stop() };
    },
    async startHttpServer() {
      // Build GitHub OAuth config when OAuth credentials are present.
      let githubOAuth: GitHubOAuthConfig | undefined;
      if (env.github?.oauthClientId && env.github?.oauthClientSecret) {
        githubOAuth = {
          clientId: env.github.oauthClientId,
          clientSecret: env.github.oauthClientSecret,
          redirectUri: `${env.baseUrl}/auth/github/callback`,
          serverBaseUrl: env.baseUrl,
        };
      }

      // The embedding client must reach the HTTP surface too, not just the
      // compile worker: POST /v1/search and every MCP tool resolve semantic
      // capability from it. Omitting it left the read path permanently in
      // fts-only mode — embeddings were written during compilation and then
      // never used — no matter how the deployment was configured.
      const server = startServer(undefined, {
        db: dbHandle.db,
        queue,
        embeddingClient,
        githubOAuth,
        githubAppConfigured: env.githubAppConfigured,
        githubWebhookConfigured: env.github?.webhookSecret !== undefined,
        githubApiClient,
      });
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
      if (!llmProvider) {
        console.warn(
          '[runtime] no env LLM provider configured — teams that have not saved ' +
          'a provider in Settings → LLM will have their compile jobs fail with ' +
          'no_llm_provider. Configure TEAMEM_ANTHROPIC_API_KEY, ' +
          'TEAMEM_OPENAI_API_KEY, or equivalent, or set one in the portal.',
        );
      }
      // Resolve the LLM per job from the team's saved BYO config (provider,
      // key, chosen model), falling back to the env provider. The handler
      // fails a job with `no_llm_provider` when neither is available, so the
      // row reaches a terminal state instead of sitting queued forever.
      const resolveLlm = createTeamLlmResolver({
        db: dbHandle.db,
        fallback: llmProvider,
      });
      const handler = createCompileJobHandler({ db: dbHandle.db, resolveLlm });
      const embeddedWorker = await startEmbeddedWorker(queue, handler);
      // Recover jobs a previous process left stuck in `processing` when it
      // was killed mid-job (see stale-job-reclaimer.ts) — otherwise those
      // rows never reach a terminal state and `/retry` keeps rejecting them
      // as "already running".
      const staleJobReclaimer = startStaleJobReclaimer(dbHandle.db);
      return {
        async stop() {
          staleJobReclaimer.stop();
          await embeddedWorker.stop();
        },
      };
    },
  };
}

/** Load config and start the runtime with real resources. */
export async function main(): Promise<Runtime> {
  const config = loadRuntimeConfig();

  // Register GitHub connector when webhook secret is configured.
  const env = parseServerEnv();
  if (env.github?.webhookSecret) {
    const githubConnector = new GitHubConnector({
      webhookSecret: env.github.webhookSecret,
    });
    registerConnector(githubConnector);
    console.log('[connector] github registered');
  }

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
