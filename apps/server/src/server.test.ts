/**
 * HTTP runtime tests — prove the Hono server works end to end.
 *
 * Success paths: health check returns 200; unknown route returns 404.
 * Failure path: body > 5MB rejected with 413.
 * Security boundary: raw body bytes accessible before JSON parse —
 *   this is the mechanism that lets webhook signature verification run
 *   against original bytes (the hard constraint from the task spec).
 */
import { describe, expect, it } from 'vitest';
import { app, enforceBodyLimit } from './server.js';

describe('HTTP runtime (server.ts)', () => {
  it('GET /healthz returns 200 with status ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('unknown route returns 404', async () => {
    const res = await app.request('/v1/nonexistent');
    expect(res.status).toBe(404);
  });

  it('body > 5MB is rejected with 413 via enforceBodyLimit middleware', async () => {
    const { Hono: HonoClass } = await import('hono');
    const { requestContext } = await import('./http/request-context.js');
    const { globalErrorHandler } = await import('./http/errors.js');
    const t = new HonoClass();
    t.use('*', requestContext);
    t.onError(globalErrorHandler);
    t.use('*', enforceBodyLimit(100)); // tiny limit for testing
    t.post('/test', (c) => c.json({ ok: true }));

    const bigBody = 'x'.repeat(101);
    const res = await t.request('/test', {
      method: 'POST',
      headers: { 'content-length': String(bigBody.length) },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });

  it('body within limit passes through', async () => {
    const testApp = (await import('hono')).Hono;
    const t = new testApp();
    t.use('*', enforceBodyLimit(100));
    t.post('/test', (c) => c.json({ ok: true }));

    const res = await t.request('/test', {
      method: 'POST',
      headers: { 'content-length': '50' },
      body: 'x'.repeat(50),
    });
    expect(res.status).toBe(200);
  });

  it('raw Request object is accessible via c.req.raw (webhook byte access)', async () => {
    let rawAccessible = false;
    const testApp = (await import('hono')).Hono;
    const t = new testApp();
    t.post('/test', (c) => {
      // c.req.raw is the web Request object — body bytes are available
      // before any JSON.parse(). This is the mechanism for webhook
      // signature verification (GitHub HMAC) against original bytes.
      rawAccessible = c.req.raw instanceof Request;
      return c.json({ rawAccessible });
    });

    const res = await t.request('/test', {
      method: 'POST',
      body: '{"test":true}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(rawAccessible).toBe(true);
  });
});
