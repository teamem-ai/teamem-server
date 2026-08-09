/**
 * Automatic schema migration on server boot.
 *
 * The production runtime image ships the compiled server plus the drizzle
 * SQL folder (apps/server/drizzle) but NOT drizzle-kit (a dev-only tool), so
 * `drizzle-kit migrate` cannot run inside the container. Instead the server
 * applies pending migrations programmatically with drizzle-orm's own
 * node-postgres migrator before it begins serving.
 *
 * Why this exists: without it, a fresh Postgres volume comes up "healthy"
 * but with zero tables — no compose service ran migrations — and the first
 * GitHub sign-in (upsertUser) or team creation fails at the database layer.
 * That silent cold-start break is the single biggest obstacle to the M2
 * "stranger self-hosts in 30 minutes" goal.
 *
 * Idempotent: drizzle records applied migrations in `drizzle.__drizzle_migrations`
 * (the same journal drizzle-kit uses), so running on every boot is a no-op
 * once the schema is current. Only the server process migrates; the compile
 * worker does not (it needs the schema but never creates it, and pg-boss
 * manages its own tables independently).
 *
 * Escape hatches:
 *   - TEAMEM_AUTO_MIGRATE=false  — skip automatic migration entirely (an
 *     operator who prefers to run migrations out-of-band).
 *   - TEAMEM_MIGRATIONS_DIR=...  — override where the drizzle SQL folder lives.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AppDb } from './client.js';

/**
 * Locate the drizzle migrations folder (the directory containing the numbered
 * `*.sql` files and `meta/_journal.json`). Returns the first candidate that
 * actually contains a journal, or null when none is found.
 *
 * The relative offset from this module differs between the compiled bundle
 * (dist/index.js → ../drizzle) and the TypeScript source running under tsx
 * (src/db/migrate.ts → ../../drizzle), and the working directory differs
 * between the container (/app) and local dev, so several candidates are
 * probed rather than assuming one layout.
 */
export function resolveMigrationsDir(): string | null {
  let hereDir: string | null = null;
  try {
    hereDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    hereDir = null;
  }

  const candidates = [
    process.env['TEAMEM_MIGRATIONS_DIR'],
    hereDir ? resolve(hereDir, '../drizzle') : undefined, // compiled: dist → apps/server/drizzle
    hereDir ? resolve(hereDir, '../../drizzle') : undefined, // src/db → apps/server/drizzle
    resolve(process.cwd(), 'apps/server/drizzle'), // dev from repo root
    resolve(process.cwd(), 'drizzle'), // dev/container from apps/server (/app layout copies here too)
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Apply pending migrations. Throws if the migrations folder cannot be located
 * (so a misconfigured deploy fails fast at startup rather than serving against
 * a partial/absent schema). No-ops when TEAMEM_AUTO_MIGRATE=false.
 */
export async function runMigrations(
  db: AppDb,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<void> {
  if (process.env['TEAMEM_AUTO_MIGRATE'] === 'false') {
    log('[migrate] TEAMEM_AUTO_MIGRATE=false — skipping automatic migrations');
    return;
  }

  const dir = resolveMigrationsDir();
  if (!dir) {
    throw new Error(
      '[migrate] could not locate the drizzle migrations folder. Set ' +
        'TEAMEM_MIGRATIONS_DIR to its absolute path, or disable automatic ' +
        'migration with TEAMEM_AUTO_MIGRATE=false and run migrations yourself.',
    );
  }

  log(`[migrate] applying pending migrations from ${dir}`);
  await migrate(db, { migrationsFolder: dir });
  log('[migrate] schema is up to date');
}
