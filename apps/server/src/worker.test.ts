/**
 * Worker entrypoint test — proves the module loads without error and the
 * exported runWorker function is callable. Real compile-queue integration
 * is exercised against a live Postgres in boss.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';

describe('worker entrypoint', () => {
  it('worker.ts exports runWorker without error', async () => {
    const mod = await import('./worker.js');
    expect(mod).toBeDefined();
    expect(typeof mod.runWorker).toBe('function');
  });
});
