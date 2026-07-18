/**
 * Runtime composition config (AGPL-3.0-only).
 *
 * Parses the process-level switches the composition root needs to decide the
 * deployment topology. The only behavioural knob for M0-PLAT-06 is
 * `TEAMEM_ALL_IN_ONE`: when true the server embeds exactly one compile worker;
 * when false (or unset) the server runs no worker and the 3-container topology
 * runs the worker as its own process.
 *
 * Cross-boundary input (env) goes through Zod, per the project red line. An
 * unrecognized boolean string is an explicit failure, not a silent default —
 * a mistyped `TEAMEM_ALL_IN_ONE=yes` must not quietly disable the worker.
 */
import { z } from 'zod';

/** Accept the shapes docker-compose / shells actually produce, nothing looser. */
const envBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const RuntimeConfigSchema = z.object({
  allInOne: envBoolean,
  databaseUrl: z.string().min(1, 'a database URL is required to start the runtime'),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Build the runtime config from an environment. `TEAMEM_ALL_IN_ONE` defaults to
 * "false" when unset (single-process mode is opt-in). The database URL prefers
 * the `TEAMEM_`-prefixed name and falls back to the compose-provided
 * `DATABASE_URL`; it is never defaulted, so a missing URL fails fast.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    allInOne: env['TEAMEM_ALL_IN_ONE'] ?? 'false',
    databaseUrl: env['TEAMEM_DATABASE_URL'] ?? env['DATABASE_URL'],
  });
}
