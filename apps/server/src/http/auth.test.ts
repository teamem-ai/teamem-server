/**
 * Auth middleware tests — requireAuth and requireScope HTTP behaviour.
 *
 * Verifies:
 * - Missing / malformed Authorization header → 401 (identical envelope)
 * - Unknown / revoked API key → 401 (identical envelope — no info leakage)
 * - Valid token attaches AuthContext to the Hono context
 * - requireScope rejects insufficient scope → 403 (identical envelope)
 * - requireScope without prior requireAuth → 401
 *
 * Uses a mock for resolveTokenHash so we can isolate the middleware's
 * HTTP contract from the database. Real-database integration is covered
 * by the events-write integration test.
 *
 * CLI: pnpm exec vitest run apps/server/src/http/auth.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';
import { requestContext } from './request-context.js';
import {
  globalErrorHandler,
  notFoundHandler,
} from './errors.js';
import {
  requireAuth,
  requireScope,
  getAuth,
  AUTH_KEY,
} from './auth.js';
import type { AppDb } from '../db/client.js';
import type { AuthContext } from '../db/repositories/api-keys.js';
import {
  generateApiKeyToken,
  hashToken,
} from '../auth/api-key.js';
import { projectScope, allProjectsScope } from '../auth/scope.js';
import type { ApiScope } from '@teamem/schema';

// ── Test app factory ────────────────────────────────────────────────────────
// Creates a fresh Hono app with error handling for each test scenario.

type TestVars = { Variables: { [AUTH_KEY]?: AuthContext } };

function createTestApp(): Hono<TestVars> {
  const app = new Hono<TestVars>().basePath('/');
  app.use('*', requestContext);
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);
  return app;
}

// ── Mock AuthContext builder ────────────────────────────────────────────────

function mockAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    credentialId: 'key_mock001',
    keyName: 'Mock Test Key',
    scopes: ['events:write', 'read'] as ApiScope[],
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

// ── Mock resolveTokenHash ───────────────────────────────────────────────────

// We mock the repository module directly so the middleware exercises every code
// path without a real database. The mock is reset between tests.
vi.mock('../db/repositories/api-keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repositories/api-keys.js')>();
  return {
    ...actual,
    resolveTokenHash: vi.fn(),
    AuthenticationError: actual.AuthenticationError,
  };
});

import {
  resolveTokenHash,
  AuthenticationError,
} from '../db/repositories/api-keys.js';

const mockedResolve = vi.mocked(resolveTokenHash);

// A minimal AppDb stub — the middleware needs a db reference but only passes it
// to resolveTokenHash, which we've mocked, so a cast is safe.
const mockDb = { $client: {} } as unknown as AppDb;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Valid token with the tm_ prefix for Bearer header testing. */
function validToken(): string {
  return generateApiKeyToken();
}

// ── Tests: requireAuth ──────────────────────────────────────────────────────

describe('requireAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 401: No Authorization header ──────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/v1/events', {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toEqual({
      code: 'unauthorized',
      message: 'Unauthorized',
    });
    // No details leak
    expect(json.error.details).toBeUndefined();
  });

  // ── 401: Malformed Authorization header ────────────────────────────────

  it('returns 401 for non-Bearer scheme', async () => {
    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 for Bearer with invalid token format (no tm_ prefix)', async () => {
    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: 'Bearer not-a-tm-token' },
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 for empty Bearer token', async () => {
    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' },
    });

    expect(res.status).toBe(401);
  });

  // ── 401: Unknown / revoked key → identical envelopes ───────────────────

  it('returns 401 for unknown API key', async () => {
    mockedResolve.mockRejectedValueOnce(new AuthenticationError('invalid or revoked API key'));

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();
    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toEqual({
      code: 'unauthorized',
      message: 'Unauthorized',
    });
  });

  it('returns 401 for revoked API key', async () => {
    // resolveTokenHash throws AuthenticationError for both unknown AND revoked
    mockedResolve.mockRejectedValueOnce(new AuthenticationError('invalid or revoked API key'));

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();
    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toEqual({
      code: 'unauthorized',
      message: 'Unauthorized',
    });
  });

  it('returns IDENTICAL 401 envelope for unknown vs revoked vs missing header', async () => {
    // All three cases must produce byte-identical error bodies
    // (no information leakage distinguishing them).
    mockedResolve.mockRejectedValue(new AuthenticationError('invalid or revoked API key'));

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();

    // Missing header
    const resMissing = await app.request('/v1/events', { method: 'GET' });
    // Unknown key
    const resUnknown = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    const bodyMissing = await resMissing.json();
    const bodyUnknown = await resUnknown.json();

    // Status codes must be identical
    expect(resMissing.status).toBe(401);
    expect(resUnknown.status).toBe(401);

    // The error shape (code, message) must be identical
    // (requestId differs per request, which is fine)
    expect(bodyMissing.error.code).toBe(bodyUnknown.error.code);
    expect(bodyMissing.error.message).toBe(bodyUnknown.error.message);
    expect(bodyMissing.error.details).toBeUndefined();
    expect(bodyUnknown.error.details).toBeUndefined();
  });

  // ── Success: valid token attaches AuthContext ──────────────────────────

  it('attaches AuthContext to context on successful auth', async () => {
    const auth = mockAuthContext();
    mockedResolve.mockResolvedValueOnce(auth);

    let capturedAuth: AuthContext | undefined;

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => {
      capturedAuth = getAuth(c);
      return c.json({ credentialId: capturedAuth.credentialId });
    });

    const token = validToken();
    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.credentialId).toBe('key_mock001');
    expect(capturedAuth).toBeDefined();
    expect(capturedAuth!.credentialId).toBe('key_mock001');
    expect(capturedAuth!.scope.kind).toBe('project');
    expect(capturedAuth!.team.id).toBe('team_mock');
    expect(capturedAuth!.scopes).toContain('events:write');
    expect(capturedAuth!.scopes).toContain('read');
  });

  // ── Token hash is computed correctly ───────────────────────────────────

  it('hashes the token before resolving', async () => {
    const auth = mockAuthContext();
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();
    await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    // Verify resolveTokenHash was called with the SHA-256 hash
    expect(mockedResolve).toHaveBeenCalledTimes(1);
    const calledWithHash = mockedResolve.mock.calls[0]![1];
    expect(calledWithHash).toBe(hashToken(token));
    // SHA-256 hex is 64 chars
    expect(calledWithHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ── Tests: requireScope ─────────────────────────────────────────────────────

describe('requireScope middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 401: requireScope without prior requireAuth ────────────────────────

  it('returns 401 when requireScope runs before requireAuth', async () => {
    const app = createTestApp();
    // No requireAuth — requireScope should reject with 401
    app.use('/v1/*', requireScope('read'));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/v1/events', { method: 'GET' });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');
  });

  // ── 403: insufficient scope ────────────────────────────────────────────

  it('returns 403 when key lacks a required scope', async () => {
    const auth = mockAuthContext({ scopes: ['read'] as ApiScope[] });
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.use('/v1/*', requireScope('events:write'));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();
    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toEqual({
      code: 'forbidden',
      message: 'Forbidden',
    });
    // No details leak about WHICH scope is missing
    expect(json.error.details).toBeUndefined();
  });

  it('returns 403 when key has only one of two required scopes', async () => {
    const auth = mockAuthContext({ scopes: ['read'] as ApiScope[] });
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.use('/v1/*', requireScope('read', 'read:payload'));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();
    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('forbidden');
  });

  // ── 403: identical envelopes across different missing scopes ───────────

  it('returns identical 403 envelope regardless of which scope is missing', async () => {
    const app1 = createTestApp();
    // Missing events:write
    const auth1 = mockAuthContext({ scopes: ['read'] as ApiScope[] });
    mockedResolve.mockResolvedValueOnce(auth1);
    app1.use('/v1/*', requireAuth(mockDb));
    app1.use('/v1/*', requireScope('events:write'));
    app1.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();
    const res1 = await app1.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    const app2 = createTestApp();
    // Missing read:payload
    const auth2 = mockAuthContext({ scopes: ['events:write', 'read'] as ApiScope[] });
    mockedResolve.mockResolvedValueOnce(auth2);
    app2.use('/v1/*', requireAuth(mockDb));
    app2.use('/v1/*', requireScope('read:payload'));
    app2.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token2 = validToken();
    const res2 = await app2.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect(res1.status).toBe(403);
    expect(res2.status).toBe(403);

    const body1 = await res1.json();
    const body2 = await res2.json();

    // Error code and message are identical — no resource info leakage
    expect(body1.error.code).toBe(body2.error.code);
    expect(body1.error.message).toBe(body2.error.message);
    expect(body1.error.details).toBeUndefined();
    expect(body2.error.details).toBeUndefined();
  });

  // ── Success: sufficient scope allows request ───────────────────────────

  it('allows request when key has the required scope', async () => {
    const auth = mockAuthContext({ scopes: ['events:write', 'read'] as ApiScope[] });
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.use('/v1/*', requireScope('events:write'));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();
    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it('allows request when key has ALL required scopes (multiple)', async () => {
    const auth = mockAuthContext({
      scopes: ['events:write', 'read', 'read:payload'] as ApiScope[],
    });
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.use('/v1/*', requireScope('read', 'read:payload'));
    app.get('/v1/events/:id', (c: Context) =>
      c.json({ eventId: c.req.param('id'), scopes: getAuth(c).scopes }),
    );

    const token = validToken();
    const res = await app.request('/v1/events/evt_123', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.eventId).toBe('evt_123');
    expect(json.scopes).toContain('read');
    expect(json.scopes).toContain('read:payload');
  });

  // ── AllProjects scope works with requireScope ─────────────────────────

  it('works correctly with allProjects scope', async () => {
    const auth = mockAuthContext({
      scopes: ['read'] as ApiScope[],
      scope: allProjectsScope('team_mock'),
    });
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.use('/v1/*', requireScope('read'));
    app.get('/v1/events', (c: Context) => {
      const a = getAuth(c);
      return c.json({ scopeKind: a.scope.kind, teamId: a.scope.teamId });
    });

    const token = validToken();
    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.scopeKind).toBe('allProjects');
    expect(json.teamId).toBe('team_mock');
  });
});

// ── Tests: scope-less requireAuth (no requireScope) ─────────────────────────

describe('requireAuth without requireScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('authenticates but does not enforce scopes', async () => {
    // A key with only 'read' scope can access a route that requires auth
    // but doesn't call requireScope
    const auth = mockAuthContext({ scopes: ['read'] as ApiScope[] });
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    // No requireScope — any authenticated key can access
    app.get('/v1/public', (c: Context) => c.json({ public: true }));

    const token = validToken();
    const res = await app.request('/v1/public', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
  });
});

// ── Tests: error boundary — internal errors during auth lookup ──────────────

describe('internal error during auth lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 500 when resolveTokenHash throws a non-AuthenticationError', async () => {
    mockedResolve.mockRejectedValueOnce(new Error('DB connection refused'));

    const app = createTestApp();
    app.use('/v1/*', requireAuth(mockDb));
    app.get('/v1/events', (c: Context) => c.json({ ok: true }));

    const token = validToken();
    const res = await app.request('/v1/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe('internal');
    // Must NOT leak internal error details
    expect(json.error.message).toBe('Internal error');
    expect(json.error.details).toBeUndefined();
  });
});
