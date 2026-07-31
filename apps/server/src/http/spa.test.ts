/**
 * SPA middleware tests (DUA-241 M2-PLAT-02).
 *
 * Tests the safe-path logic and SPA fallback behaviour:
 *   1. Static file serving from the dist directory.
 *   2. SPA fallback (index.html) for client-side routes.
 *   3. NOT intercepting POST requests (API routes take precedence).
 *   4. Path traversal blocking.
 *   5. Graceful pass-through when dist directory is absent.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createSpaMiddleware } from './spa.js';

// ── Helper: create a temporary dist directory with index.html + asset ──────

function createTempDist() {
  const root = mkdtempSync(join(tmpdir(), 'teamem-spa-test-'));
  mkdirSync(join(root, 'assets'), { recursive: true });

  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><body>SPA</body></html>',
  );
  writeFileSync(
    join(root, 'assets', 'app.js'),
    'console.log("hello");',
  );

  return root;
}

// ── Helpers for creating test apps ─────────────────────────────────────────

function appWithDist(distPath: string) {
  const prev = process.env['TEAMEM_WEB_DIST_PATH'];
  process.env['TEAMEM_WEB_DIST_PATH'] = distPath;

  const app = new Hono();
  // Mount a few API-like routes that the SPA middleware must not intercept.
  app.get('/healthz', (c) => c.text('ok'));
  app.get('/v1/concepts', (c) => c.json({ data: [] }));

  // Mount the SPA middleware last.
  app.use('*', createSpaMiddleware());

  // Restore after creation (the middleware reads the env var at creation time).
  if (prev === undefined) {
    delete process.env['TEAMEM_WEB_DIST_PATH'];
  } else {
    process.env['TEAMEM_WEB_DIST_PATH'] = prev;
  }

  // Store for cleanup
  return { app, distPath };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SPA middleware', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = createTempDist();
  });

  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  // ── 1. API routes are not intercepted ─────────────────────────────────

  it('does not intercept /healthz', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('does not intercept /v1/concepts (JSON API)', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/v1/concepts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('does not intercept POST requests', async () => {
    const { app } = appWithDist(distDir);
    // POST to a path that would be served as an SPA file on GET.
    const res = await app.request('/index.html', { method: 'POST' });
    // No POST route mounted — should return 404, not the static file.
    expect(res.status).toBe(404);
  });

  // ── 2. Static file serving ───────────────────────────────────────────

  it('serves index.html for GET /', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('SPA');
  });

  it('serves index.html for GET /index.html', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('SPA');
  });

  it('serves static assets from subdirectories', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('hello');
  });

  // ── 3. SPA fallback ──────────────────────────────────────────────────

  it('falls back to index.html for client-side routes', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/knowledge');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('SPA');
  });

  it('falls back to index.html for nested client-side routes', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/settings/keys');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('SPA');
  });

  // ── 4. Path traversal is blocked ─────────────────────────────────────
  // safePath() rejects traversal attempts (returns null). The SPA fallback
  // then kicks in and serves index.html (status 200). The important
  // guarantee is that no file *outside* the dist directory can be read —
  // an attacker only gets the public SPA page, not arbitrary filesystem
  // access. We verify this by checking the response body is index.html,
  // not the targeted sensitive file.

  it('does not serve files outside dist dir via .. traversal', async () => {
    const { app } = appWithDist(distDir);
    // ../ should not escape the dist directory
    const res = await app.request('/../package.json');
    // The request DOES get a response (SPA fallback to index.html), but
    // it must NOT be the project's actual package.json.
    expect(res.status).toBe(200);
    const body = await res.text();
    // index.html contains "SPA" — package.json would contain "name".
    expect(body).toContain('SPA');
    expect(body).not.toContain('"name"');
  });

  it('does not serve files outside dist dir via encoded traversal', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/..%2F..%2Fetc%2Fpasswd');
    // Same as above — SPA fallback kicks in, not the targeted file.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA');
  });

  // ── 5. No dist dir → graceful pass-through ───────────────────────────

  it('passes through when dist directory does not exist', async () => {
    const { app } = appWithDist('/tmp/nonexistent-teamem-dist-xyz');

    // Client-side route returns 404 because the dist doesn't exist.
    const res = await app.request('/knowledge');
    expect(res.status).toBe(404);
  });

  // ── 6. HEAD requests (same as GET but no body) ───────────────────────

  it('handles HEAD requests for static files', async () => {
    const { app } = appWithDist(distDir);
    const res = await app.request('/assets/app.js', { method: 'HEAD' });
    expect(res.status).toBe(200);
    // HEAD must not return a body.
    expect(await res.text()).toBe('');
  });
});
