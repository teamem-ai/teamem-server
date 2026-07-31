/**
 * Unit tests for the E2E setup route builder.
 *
 * These tests verify the route registration gate: the route is only built
 * when TEAMEM_E2E_SECRET is present, and is absent otherwise.
 */
import { describe, expect, it } from 'vitest';
import { buildE2eSetupRoutes } from './e2e-setup.js';

const mockDb = {
  $client: {
    query: async () => ({ rows: [] }),
  },
} as unknown as import('../../db/client.js').AppDb;

describe('buildE2eSetupRoutes', () => {
  it('returns a Hono instance when a secret is provided', () => {
    const routes = buildE2eSetupRoutes({ db: mockDb, secret: 'test-secret' });
    expect(routes).not.toBeNull();
  });

  it('returns null when no secret is provided', () => {
    const routes = buildE2eSetupRoutes({ db: mockDb, secret: '' });
    expect(routes).toBeNull();
  });
});
