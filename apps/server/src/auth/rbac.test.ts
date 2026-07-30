/**
 * Unit tests for Role-Based Access Control (rbac.ts).
 *
 * Verifies:
 * - Role rank computation (viewer < member < admin < owner)
 * - checkRole for all valid combinations
 * - requireRole middleware:
 *   - Allows request when session role >= minRole
 *   - Returns 403 when session role < minRole (identical envelope)
 *   - Returns 401 when requireWebSession was not run before requireRole
 *   - Returns 401 when session context is missing/null
 */
import { describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import {
  roleRank,
  checkRole,
  requireRole,
} from './rbac.js';
import type { TeamRole } from '@teamem/schema';
import {
  requestContext,
} from '../http/request-context.js';
import {
  globalErrorHandler,
  notFoundHandler,
} from '../http/errors.js';
import {
  WEB_SESSION_KEY,
  type WebSessionContext,
} from '../http/session.js';
import { allProjectsScope } from './scope.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

type TestVars = { Variables: { [WEB_SESSION_KEY]?: WebSessionContext } };

function createTestApp(): Hono<TestVars> {
  const app = new Hono<TestVars>().basePath('/');
  app.use('*', requestContext);
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);
  return app;
}

function mockWebSession(overrides: Partial<WebSessionContext> = {}): WebSessionContext {
  return {
    userId: 'usr_testuser',
    sessionId: 'ses_test',
    githubLogin: 'testuser',
    avatarUrl: null,
    teamRole: 'viewer' as TeamRole,
    scope: allProjectsScope('team_test'),
    ...overrides,
  };
}

/** Middleware that injects a mock WebSessionContext (simulates requireWebSession). */
function injectWebSession(session: WebSessionContext) {
  return async (c: Context, next: () => Promise<void>) => {
    c.set(WEB_SESSION_KEY, session);
    await next();
  };
}

// ══════════════════════════════════════════════════════════════════════════
// roleRank
// ══════════════════════════════════════════════════════════════════════════

describe('roleRank', () => {
  it('viewer has the lowest rank', () => {
    expect(roleRank('viewer')).toBe(0);
  });

  it('member is above viewer', () => {
    expect(roleRank('member')).toBe(1);
  });

  it('admin is above member', () => {
    expect(roleRank('admin')).toBe(2);
  });

  it('owner is the highest rank', () => {
    expect(roleRank('owner')).toBe(3);
  });

  it('ranks are strictly increasing', () => {
    expect(roleRank('viewer')).toBeLessThan(roleRank('member'));
    expect(roleRank('member')).toBeLessThan(roleRank('admin'));
    expect(roleRank('admin')).toBeLessThan(roleRank('owner'));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// checkRole
// ══════════════════════════════════════════════════════════════════════════

describe('checkRole', () => {
  it('returns true when userRole equals minRole', () => {
    expect(checkRole('viewer', 'viewer')).toBe(true);
    expect(checkRole('member', 'member')).toBe(true);
    expect(checkRole('admin', 'admin')).toBe(true);
    expect(checkRole('owner', 'owner')).toBe(true);
  });

  it('returns true when userRole exceeds minRole', () => {
    expect(checkRole('member', 'viewer')).toBe(true);
    expect(checkRole('admin', 'viewer')).toBe(true);
    expect(checkRole('owner', 'viewer')).toBe(true);
    expect(checkRole('admin', 'member')).toBe(true);
    expect(checkRole('owner', 'member')).toBe(true);
    expect(checkRole('owner', 'admin')).toBe(true);
  });

  it('returns false when userRole is below minRole', () => {
    expect(checkRole('viewer', 'member')).toBe(false);
    expect(checkRole('viewer', 'admin')).toBe(false);
    expect(checkRole('viewer', 'owner')).toBe(false);
    expect(checkRole('member', 'admin')).toBe(false);
    expect(checkRole('member', 'owner')).toBe(false);
    expect(checkRole('admin', 'owner')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// requireRole middleware — success paths
// ══════════════════════════════════════════════════════════════════════════

describe('requireRole middleware — success', () => {
  it('allows viewer to access viewer route', async () => {
    const session = mockWebSession({ teamRole: 'viewer' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('viewer'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(200);
  });

  it('allows member to access viewer route', async () => {
    const session = mockWebSession({ teamRole: 'member' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('viewer'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(200);
  });

  it('allows admin to access member route', async () => {
    const session = mockWebSession({ teamRole: 'admin' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('member'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(200);
  });

  it('allows owner to access admin route', async () => {
    const session = mockWebSession({ teamRole: 'owner' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('admin'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// requireRole middleware — rejection paths
// ══════════════════════════════════════════════════════════════════════════

describe('requireRole middleware — rejection', () => {
  it('rejects viewer from member route with 403', async () => {
    const session = mockWebSession({ teamRole: 'viewer' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('member'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('forbidden');
    // No details leak
    expect(json.error.details).toBeUndefined();
  });

  it('rejects viewer from admin route with 403', async () => {
    const session = mockWebSession({ teamRole: 'viewer' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('admin'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(403);
  });

  it('rejects viewer from owner route with 403', async () => {
    const session = mockWebSession({ teamRole: 'viewer' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('owner'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(403);
  });

  it('rejects member from admin route with 403', async () => {
    const session = mockWebSession({ teamRole: 'member' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('admin'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('forbidden');
    expect(json.error.details).toBeUndefined();
  });

  it('rejects member from owner route with 403', async () => {
    const session = mockWebSession({ teamRole: 'member' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('owner'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(403);
  });

  it('rejects admin from owner route with 403', async () => {
    const session = mockWebSession({ teamRole: 'admin' });
    const app = createTestApp();
    app.use('/test/*', injectWebSession(session));
    app.use('/test/*', requireRole('owner'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// requireRole: identical 403 envelopes
// ══════════════════════════════════════════════════════════════════════════

describe('requireRole — identical 403 envelopes', () => {
  it('returns identical 403 for viewer→member vs viewer→admin vs viewer→owner', async () => {
    const session = mockWebSession({ teamRole: 'viewer' });

    async function tryAccess(minRole: TeamRole): Promise<{ status: number; body: unknown }> {
      const app = createTestApp();
      app.use('/test/*', injectWebSession(session));
      app.use('/test/*', requireRole(minRole));
      app.get('/test/resource', (c: Context) => c.json({ ok: true }));
      const res = await app.request('/test/resource');
      return { status: res.status, body: await res.json() };
    }

    const resultMember = await tryAccess('member');
    const resultAdmin = await tryAccess('admin');
    const resultOwner = await tryAccess('owner');

    // All return 403
    expect(resultMember.status).toBe(403);
    expect(resultAdmin.status).toBe(403);
    expect(resultOwner.status).toBe(403);

    // Error code and message are identical
    const bodyMember = resultMember.body as Record<string, unknown>;
    const bodyAdmin = resultAdmin.body as Record<string, unknown>;
    const bodyOwner = resultOwner.body as Record<string, unknown>;

    const errMember = bodyMember['error'] as Record<string, unknown>;
    const errAdmin = bodyAdmin['error'] as Record<string, unknown>;
    const errOwner = bodyOwner['error'] as Record<string, unknown>;

    expect(errMember['code']).toBe(errAdmin['code']);
    expect(errMember['message']).toBe(errAdmin['message']);
    expect(errAdmin['code']).toBe(errOwner['code']);
    expect(errAdmin['message']).toBe(errOwner['message']);

    // No details to distinguish which role was missing
    expect(errMember['details']).toBeUndefined();
    expect(errAdmin['details']).toBeUndefined();
    expect(errOwner['details']).toBeUndefined();
  });

  it('returns identical 403 for member→admin vs member→owner', async () => {
    const session = mockWebSession({ teamRole: 'member' });

    async function tryAccess(minRole: TeamRole): Promise<{ status: number; body: unknown }> {
      const app = createTestApp();
      app.use('/test/*', injectWebSession(session));
      app.use('/test/*', requireRole(minRole));
      app.get('/test/resource', (c: Context) => c.json({ ok: true }));
      const res = await app.request('/test/resource');
      return { status: res.status, body: await res.json() };
    }

    const resultAdmin = await tryAccess('admin');
    const resultOwner = await tryAccess('owner');

    expect(resultAdmin.status).toBe(403);
    expect(resultOwner.status).toBe(403);

    const errAdmin = ((resultAdmin.body as Record<string, unknown>)['error'] as Record<string, unknown>);
    const errOwner = ((resultOwner.body as Record<string, unknown>)['error'] as Record<string, unknown>);

    expect(errAdmin['code']).toBe(errOwner['code']);
    expect(errAdmin['message']).toBe(errOwner['message']);
  });

  it('returns identical 403 for admin→owner vs viewer→owner', async () => {
    // Different roles, same denial — envelopes must be identical
    const sessionAdmin = mockWebSession({ teamRole: 'admin' });
    const sessionViewer = mockWebSession({ teamRole: 'viewer' });

    async function tryAccess(session: WebSessionContext, minRole: TeamRole): Promise<{ status: number; body: unknown }> {
      const app = createTestApp();
      app.use('/test/*', injectWebSession(session));
      app.use('/test/*', requireRole(minRole));
      app.get('/test/resource', (c: Context) => c.json({ ok: true }));
      const res = await app.request('/test/resource');
      return { status: res.status, body: await res.json() };
    }

    const resultAdmin = await tryAccess(sessionAdmin, 'owner');
    const resultViewer = await tryAccess(sessionViewer, 'owner');

    expect(resultAdmin.status).toBe(403);
    expect(resultViewer.status).toBe(403);

    const errAdmin = ((resultAdmin.body as Record<string, unknown>)['error'] as Record<string, unknown>);
    const errViewer = ((resultViewer.body as Record<string, unknown>)['error'] as Record<string, unknown>);

    expect(errAdmin['code']).toBe(errViewer['code']);
    expect(errAdmin['message']).toBe(errViewer['message']);
    expect(errAdmin['details']).toBeUndefined();
    expect(errViewer['details']).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// requireRole without prior requireWebSession
// ══════════════════════════════════════════════════════════════════════════

describe('requireRole without session middleware', () => {
  it('returns 401 when requireRole runs before requireWebSession', async () => {
    const app = createTestApp();
    // No injectWebSession — simulates requireWebSession not run
    app.use('/test/*', requireRole('viewer'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');
  });

  it('returns 401 when session context is explicitly null', async () => {
    const app = createTestApp();
    // Inject null as the session
    app.use('/test/*', async (c: Context, next: () => Promise<void>) => {
      c.set(WEB_SESSION_KEY, null);
      await next();
    });
    app.use('/test/*', requireRole('viewer'));
    app.get('/test/resource', (c: Context) => c.json({ ok: true }));

    const res = await app.request('/test/resource');
    // When session is null, getWebSession receives null (not undefined),
    // which is falsy so it throws UnauthorizedError
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Full role ladder — every role can access its own level
// ══════════════════════════════════════════════════════════════════════════

describe('full role ladder', () => {
  const allRoles: TeamRole[] = ['viewer', 'member', 'admin', 'owner'];

  for (const userRole of allRoles) {
    for (const minRole of allRoles) {
      const expectedStatus = roleRank(userRole) >= roleRank(minRole) ? 200 : 403;
      it(`${userRole} accessing ${minRole} route → ${expectedStatus}`, async () => {
        const session = mockWebSession({ teamRole: userRole });
        const app = createTestApp();
        app.use('/test/*', injectWebSession(session));
        app.use('/test/*', requireRole(minRole));
        app.get('/test/resource', (c: Context) => c.json({ ok: true }));

        const res = await app.request('/test/resource');
        expect(res.status).toBe(expectedStatus);
      });
    }
  }
});
