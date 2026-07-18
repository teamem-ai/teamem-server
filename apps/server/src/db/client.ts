/**
 * Minimal Drizzle client factory. Connection lifecycle (pooling policy, env
 * wiring) belongs to the server bootstrap task; this only gives repository
 * code and integration tests a typed handle onto a Postgres connection
 * string.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type AppDb = ReturnType<typeof createDb>;

/**
 * Like {@link createDb}, but exposes the underlying pool and a `close()` so the
 * composition root can own the connection's lifecycle (open on startup, drain
 * last on shutdown). `close()` resolves once every pooled socket is released.
 */
export function createDbHandle(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export type AppDbHandle = ReturnType<typeof createDbHandle>;
