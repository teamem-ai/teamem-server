/**
 * Route-layer tests for POST /v1/search (DUA-205 M1-SR-03).
 *
 * Validates the HTTP contract of the search route:
 * - Explicit limit > 100 → 400 with max=100 indication
 * - Zod validation errors reach the client with formatted details
 * - Null body → 400 (not 500)
 * - Error envelope shape matches the frozen contract
 *
 * Tests call the real exported postSearchHandler through a Hono app
 * with a mock search use case, so the actual validation logic in
 * search.ts is exercised — not a local replica.
 *
 * Full end-to-end tests with real auth and DB are in:
 *   apps/server/src/search/search-use-case.integration.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { searchRequest, searchResponse } from '@teamem/schema';
import type { ApiScope } from '@teamem/schema';
import { requestContext } from '../request-context.js';
import { globalErrorHandler, notFoundHandler } from '../errors.js';
import { postSearchHandler, type SearchRoutesDeps } from './search.js';
import type { AuthContext } from '../../db/repositories/api-keys.js';
import { projectScope } from '../../auth/scope.js';
import { AUTH_KEY } from '../auth.js';
import type { AuthVariables } from '../auth.js';

// ── Mock search use case ────────────────────────────────────────────────────

vi.mock('../../search/search-use-case.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../search/search-use-case.js')>();
  return {
    ...actual,
    search: vi.fn(),
  };
});

import { search as mockedSearch } from '../../search/search-use-case.js';
const mockedSearchFn = vi.mocked(mockedSearch);

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    credentialId: 'key_mock001',
    keyName: 'Mock Test Key',
    scopes: ['read', 'events:write'] as ApiScope[],
    scope: projectScope('team_mock', 'prj_mock'),
    principal: {
      id: 'pri_mock001',
      kind: 'service',
      provider: 'external',
      providerKind: 'teamem',
      providerUserId: 'bootstrap:mock',
      displayLogin: 'mock-service',
    },
    team: { id: 'team_mock', name: 'Mock Team' },
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Build a test Hono app that wires the real postSearchHandler behind
 * the requestContext middleware (provides requestId) and sets up a
 * mock AuthContext via a small middleware so getAuth(c) works.
 *
 * This exercises the actual validation logic in search.ts rather than
 * a local replica.
 */
function createTestApp(deps: SearchRoutesDeps) {
  const app = new Hono<{ Variables: AuthVariables }>().basePath('/');
  app.use('*', requestContext);
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);

  // Set mock auth context so getAuth(c) works inside the real handler.
  app.use('/v1/search', async (c, next) => {
    c.set(AUTH_KEY, mockAuthContext());
    await next();
  });

  app.post('/v1/search', async (c) => postSearchHandler(c, deps));

  return app;
}

function authHeaders() {
  return { 'Content-Type': 'application/json' };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /v1/search route (DUA-205 M1-SR-03)', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedSearchFn.mockResolvedValue({
      requestId: 'req_test',
      results: [],
      degraded: true,
      nextCursor: null,
    });

    app = createTestApp({ db: {} as never });
  });

  // ── Success ──────────────────────────────────────────────────────────

  it('returns 200 with search response for a valid request', async () => {
    mockedSearchFn.mockResolvedValue({
      requestId: 'req_test',
      results: [{
        uuid: '12345678-1234-4234-8234-123456789abc',
        path: 'services/auth',
        type: 'service',
        status: 'active',
        confidence: 'high',
        title: 'Auth Service',
        tags: ['auth'],
        lastConfirmed: '2025-06-01T00:00:00.000Z',
        relevance: 0.85,
        ftsFallback: true,
      }],
      degraded: true,
      nextCursor: null,
    });

    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: 'prj_mock',
        query: 'test query',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.requestId).toBeDefined();
    expect(json.results).toBeInstanceOf(Array);
    expect(json.results).toHaveLength(1);
    expect(json.degraded).toBe(true);
  });

  // ── limit > 100 → 400 with max=100 indication ───────────────────────

  it('returns 400 with max=100 indication when limit exceeds 100', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: 'prj_mock',
        query: 'test',
        limit: 101,
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
    // DUA-205: response must indicate max=100
    expect(json.error.details).toBeDefined();
    expect(json.error.details.field).toBe('limit');
    expect(json.error.details.max).toBe('100');
    expect(json.error.details.provided).toBe('101');
  });

  it('accepts limit=100 exactly (boundary)', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: 'prj_mock',
        query: 'test',
        limit: 100,
      }),
    });

    expect(res.status).toBe(200);
  });

  it('accepts limit=1 (minimum)', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: 'prj_mock',
        query: 'test',
        limit: 1,
      }),
    });

    expect(res.status).toBe(200);
  });

  // ── Null body → 400 (not 500) ───────────────────────────────────────

  it('returns 400 for null JSON body (not 500)', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: 'null',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  // ── Zod validation errors reach client ───────────────────────────────

  it('returns 400 with validation details for missing projectId', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ query: 'test' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
    // Validation details must reach the client
    expect(json.error.details).toBeDefined();
    expect(json.error.details.validation).toBeDefined();
    expect(json.error.details.validation).toContain('projectId');
  });

  it('returns 400 for invalid type filter', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: 'prj_mock',
        query: 'test',
        type: 'invalid-type',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
    expect(json.error.details).toBeDefined();
    expect(json.error.details.validation).toBeDefined();
  });

  it('returns 400 for empty query string', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: 'prj_mock',
        query: '',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  it('returns 400 for query exceeding 500 characters', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: 'prj_mock',
        query: 'x'.repeat(501),
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  it('returns 400 for a non-JSON body', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: 'not json at all',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
  });

  // ── Frozen contract compliance ───────────────────────────────────────

  it('searchRequest schema rejects limit > 100', () => {
    const result = searchRequest.safeParse({
      projectId: 'prj_test123',
      query: 'test',
      limit: 101,
    });
    expect(result.success).toBe(false);
  });

  it('searchRequest schema accepts limit=100 exactly', () => {
    const result = searchRequest.safeParse({
      projectId: 'prj_test123',
      query: 'test',
      limit: 100,
    });
    expect(result.success).toBe(true);
  });

  it('searchRequest schema applies default limit of 20 when omitted', () => {
    const result = searchRequest.safeParse({
      projectId: 'prj_test123',
      query: 'test',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it('searchResponse schema validates a valid response', () => {
    const response = {
      requestId: 'req_test',
      results: [{
        uuid: '12345678-1234-4234-8234-123456789abc',
        path: 'services/auth',
        type: 'service',
        status: 'active',
        confidence: 'high',
        title: 'Auth Service',
        tags: ['auth'],
        lastConfirmed: '2025-06-01T00:00:00.000Z',
        relevance: 0.85,
        ftsFallback: true,
      }],
      degraded: true,
      nextCursor: null,
    };
    const result = searchResponse.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('searchResponse schema rejects relevance outside [0,1]', () => {
    const response = {
      requestId: 'req_test',
      results: [{
        uuid: '12345678-1234-4234-8234-123456789abc',
        path: 'services/auth',
        type: 'service' as const,
        status: 'active' as const,
        confidence: 'high' as const,
        title: 'Auth Service',
        tags: ['auth'],
        lastConfirmed: '2025-06-01T00:00:00.000Z',
        relevance: 1.5,
        ftsFallback: true,
      }],
      degraded: true,
      nextCursor: null,
    };
    const result = searchResponse.safeParse(response);
    expect(result.success).toBe(false);
  });

  // ── Error envelope shape ─────────────────────────────────────────────

  it('error responses conform to the frozen error envelope', async () => {
    const res = await app.request('/v1/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: 'prj_mock',
        query: 'test',
        limit: 101,
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();

    // Frozen envelope: { requestId, error: { code, message, details? } }
    expect(json.requestId).toBeDefined();
    expect(typeof json.requestId).toBe('string');
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe('invalid_request');
    expect(json.error.message).toBeDefined();
    expect(typeof json.error.message).toBe('string');
    // No sensitive keys leaked
    expect(json.error.stack).toBeUndefined();
    expect(json.error.cause).toBeUndefined();
    expect(json.error.sql).toBeUndefined();
  });
});
