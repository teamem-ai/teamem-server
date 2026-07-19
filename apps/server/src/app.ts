/**
 * Injectable Hono app factory (AGPL-3.0-only)
 *
 * `buildApp()` creates a fully configured Hono instance.  Dependencies
 * (database URL, future LLM keys, etc.) are injected via the `AppDeps`
 * parameter so the factory is testable without environment side-effects.
 *
 * This module owns route wiring.  Handler implementations live in
 * `http/health.ts` (and future route modules).
 */
import { Hono, type Context, type Next } from 'hono';
import { healthzHandler, readyzHandler, type HealthDeps } from './http/health.js';

export type AppDeps = HealthDeps;

type AppEnv = { Variables: { healthDeps: AppDeps } };

function injectDeps(deps: AppDeps) {
  return async (c: Context<AppEnv>, next: Next) => {
    c.set('healthDeps', deps);
    await next();
  };
}

export function buildApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>().basePath('/');

  app.use('*', injectDeps(deps));
  app.get('/healthz', healthzHandler);
  app.get('/readyz', readyzHandler);

  return app;
}

export type App = ReturnType<typeof buildApp>;
