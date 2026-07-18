/**
 * Request-context middleware tests — prove request ID acceptance and generation.
 *
 * Success paths: incoming x-request-id reused; missing header generates UUID;
 *   requestId available in handler context; response header echoed.
 * Boundary: empty header treated as missing.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestContext } from './request-context.js';
import { REQUEST_ID_KEY } from './errors.js';

type TestEnv = { Variables: { requestId: string } };

function createTestApp() {
  const app = new Hono<TestEnv>().basePath('/');
  app.use('*', requestContext);
  return app;
}

describe('requestContext middleware', () => {
  it('uses the incoming x-request-id header when present', async () => {
    const app = createTestApp();
    app.get('/test', (c) => {
      return c.json({ requestId: c.get(REQUEST_ID_KEY) });
    });

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'caller-id-123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBe('caller-id-123');
    expect(res.headers.get('x-request-id')).toBe('caller-id-123');
  });

  it('generates a UUID when no x-request-id header is present', async () => {
    const app = createTestApp();
    app.get('/test', (c) => {
      return c.json({ requestId: c.get(REQUEST_ID_KEY) });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('treats empty x-request-id as missing and generates a UUID', async () => {
    const app = createTestApp();
    app.get('/test', (c) => {
      return c.json({ requestId: c.get(REQUEST_ID_KEY) });
    });

    const res = await app.request('/test', {
      headers: { 'x-request-id': '   ' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('trims whitespace from incoming x-request-id', async () => {
    const app = createTestApp();
    app.get('/test', (c) => {
      return c.json({ requestId: c.get(REQUEST_ID_KEY) });
    });

    const res = await app.request('/test', {
      headers: { 'x-request-id': '  my-id  ' },
    });
    const body = await res.json();
    expect(body.requestId).toBe('my-id');
  });

  it('sets x-request-id response header', async () => {
    const app = createTestApp();
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'resp-header-test' },
    });
    expect(res.headers.get('x-request-id')).toBe('resp-header-test');
  });

  it('the same requestId is used across handler and response header', async () => {
    const app = createTestApp();
    app.get('/test', (c) => {
      return c.json({ requestId: c.get(REQUEST_ID_KEY) });
    });

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'consistent-id' },
    });
    const body = await res.json();
    expect(body.requestId).toBe('consistent-id');
    expect(res.headers.get('x-request-id')).toBe('consistent-id');
  });
});
