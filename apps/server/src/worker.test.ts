/**
 * Worker entrypoint test — proves the module loads without error.
 * Real compile behavior lands with M0 F1/F2 tasks.
 */
import { describe, expect, it } from 'vitest';

describe('worker entrypoint', () => {
  it('worker.ts exports without error', async () => {
    const mod = await import('./worker.js');
    expect(mod).toBeDefined();
  });
});
