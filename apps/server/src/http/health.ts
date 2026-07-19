/**
 * Health-check route handlers (AGPL-3.0-only)
 *
 * /healthz  — liveness: process is alive (no dependencies required).
 * /readyz   — readiness: process can serve traffic (DB reachable).
 *
 * Readiness must never leak credentials, connection strings, or raw
 * exception details.  A generic error code suffices; the monitoring
 * system correlates it with server logs.
 */
import type { Context } from 'hono';
import { Pool } from 'pg';

export interface HealthDeps {
  /** Database connection string used for the readiness probe. */
  dbUrl?: string;
}

type HealthEnv = { Variables: { appDeps: HealthDeps } };

export function healthzHandler(c: Context) {
  return c.json({ status: 'ok' });
}

export async function readyzHandler(c: Context<HealthEnv>) {
  const { dbUrl } = c.var.appDeps ?? {};

  if (!dbUrl) {
    return c.json({ status: 'not_ready', error: 'database_not_configured' }, 503);
  }

  let client: Pool | undefined;
  try {
    client = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 3_000 });
    await client.query('SELECT 1');
    return c.json({ status: 'ok' });
  } catch {
    return c.json({ status: 'not_ready', error: 'database_unreachable' }, 503);
  } finally {
    await client?.end();
  }
}
