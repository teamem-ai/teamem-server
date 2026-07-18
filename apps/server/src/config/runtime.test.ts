/**
 * Runtime config parsing (M0-PLAT-06).
 *
 * Success: recognized boolean strings map to the right topology.
 * Default: unset TEAMEM_ALL_IN_ONE is single-process-off (false).
 * Boundary/counterexample: a mistyped boolean is rejected, not silently
 * treated as false — a typo must never quietly disable the worker.
 */
import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './runtime.js';

const DB = 'postgres://u:p@localhost:5432/teamem';

describe('loadRuntimeConfig', () => {
  it('TEAMEM_ALL_IN_ONE=true → allInOne true', () => {
    const cfg = loadRuntimeConfig({ TEAMEM_ALL_IN_ONE: 'true', DATABASE_URL: DB });
    expect(cfg.allInOne).toBe(true);
  });

  it('TEAMEM_ALL_IN_ONE=false → allInOne false', () => {
    const cfg = loadRuntimeConfig({ TEAMEM_ALL_IN_ONE: 'false', DATABASE_URL: DB });
    expect(cfg.allInOne).toBe(false);
  });

  it('accepts 1/0 as booleans', () => {
    expect(loadRuntimeConfig({ TEAMEM_ALL_IN_ONE: '1', DATABASE_URL: DB }).allInOne).toBe(true);
    expect(loadRuntimeConfig({ TEAMEM_ALL_IN_ONE: '0', DATABASE_URL: DB }).allInOne).toBe(false);
  });

  it('unset TEAMEM_ALL_IN_ONE defaults to false', () => {
    expect(loadRuntimeConfig({ DATABASE_URL: DB }).allInOne).toBe(false);
  });

  it('prefers TEAMEM_DATABASE_URL over DATABASE_URL', () => {
    const cfg = loadRuntimeConfig({
      TEAMEM_DATABASE_URL: 'postgres://teamem/one',
      DATABASE_URL: 'postgres://teamem/two',
    });
    expect(cfg.databaseUrl).toBe('postgres://teamem/one');
  });

  it('rejects an unrecognized boolean string (counterexample: "yes")', () => {
    expect(() => loadRuntimeConfig({ TEAMEM_ALL_IN_ONE: 'yes', DATABASE_URL: DB })).toThrow();
  });

  it('rejects a missing database URL', () => {
    expect(() => loadRuntimeConfig({ TEAMEM_ALL_IN_ONE: 'false' })).toThrow();
  });
});
