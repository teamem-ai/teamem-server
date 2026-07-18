/**
 * Drizzle + pg client lifecycle: typed pool construction with bounded
 * defaults, a startup connectivity check, and graceful shutdown. Env wiring
 * (reading TEAMEM_DATABASE_URL etc.) belongs to the server bootstrap task —
 * this module only takes an already-resolved connection string, so it has
 * no opinion on where that string comes from.
 */
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export interface DbPoolBounds {
  /** Max simultaneous connections. Unbounded pools let a traffic spike
   * exhaust Postgres's max_connections and take down every other client;
   * default keeps a single server/worker process well inside that limit. */
  max?: number;
  min?: number;
  /** How long an idle connection stays open before the pool closes it. */
  idleTimeoutMillis?: number;
  /** How long to wait for a new connection before failing. Bounds the
   * startup connectivity check so an unreachable database fails fast
   * instead of hanging the process. */
  connectionTimeoutMillis?: number;
}

export interface CreateDbOptions extends DbPoolBounds {
  /** Injection seam for tests: supply a pre-built Pool (real or fake)
   * instead of letting createDb construct one from connectionString+bounds. */
  pool?: Pool;
}

const DEFAULT_POOL_BOUNDS: Required<DbPoolBounds> = {
  max: 10,
  min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const { pool: injectedPool, ...bounds } = options;
  const poolConfig: PoolConfig = {
    connectionString,
    max: bounds.max ?? DEFAULT_POOL_BOUNDS.max,
    min: bounds.min ?? DEFAULT_POOL_BOUNDS.min,
    idleTimeoutMillis: bounds.idleTimeoutMillis ?? DEFAULT_POOL_BOUNDS.idleTimeoutMillis,
    connectionTimeoutMillis:
      bounds.connectionTimeoutMillis ?? DEFAULT_POOL_BOUNDS.connectionTimeoutMillis,
  };
  const pool = injectedPool ?? new Pool(poolConfig);
  return drizzle(pool, { schema });
}

export type AppDb = ReturnType<typeof createDb>;

/**
 * Startup connectivity check: acquires and releases one real connection so
 * an unreachable/misconfigured database is reported immediately (bounded by
 * connectionTimeoutMillis) rather than surfacing on the first business query.
 */
export async function checkDbConnectivity(db: AppDb): Promise<void> {
  await db.$client.query('SELECT 1');
}

/**
 * Graceful shutdown: waits for in-flight queries to finish, then closes
 * every pooled connection. Safe to call once per createDb() handle.
 */
export async function closeDb(db: AppDb): Promise<void> {
  await db.$client.end();
}
