/**
 * Health-check route tests — prove liveness and readiness work end to end.
 *
 * Success path: /healthz returns 200 with stable body.
 * Success path: /readyz returns 200 when DB is reachable.
 * Failure path: /readyz returns 503 when DB URL is missing.
 * Failure path: /readyz returns 503 when DB is unreachable.
 * Security boundary: /readyz error bodies never contain connection
 *   strings or raw exception text.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

describe('Health probes (http/health.ts)', () => {
  // ── /healthz — liveness ──────────────────────────────────────────────────

  describe('/healthz', () => {
    it('returns 200 with status ok', async () => {
      const app = buildApp();
      const res = await app.request('/healthz');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });
    });

    it('does not require any dependencies', async () => {
      const app = buildApp({});
      const res = await app.request('/healthz');
      expect(res.status).toBe(200);
    });
  });

  // ── /readyz — readiness ──────────────────────────────────────────────────

  describe('/readyz', () => {
    it('returns 503 when database URL is not configured', async () => {
      const app = buildApp({});
      const res = await app.request('/readyz');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: 'not_ready', error: 'database_not_configured' });
    });

    it('returns 503 when database is unreachable (bad URL)', async () => {
      const app = buildApp({ dbUrl: 'postgresql://nohost:5432/nodb' });
      const res = await app.request('/readyz');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: 'not_ready', error: 'database_unreachable' });
    });

    it('error body never leaks the connection string', async () => {
      const secretUrl = 'postgresql://admin:s3cret@db.internal:5432/teamem';
      const app = buildApp({ dbUrl: secretUrl });
      const res = await app.request('/readyz');
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain('s3cret');
      expect(text).not.toContain('db.internal');
      expect(text).not.toContain(secretUrl);
    });

    it('returns 200 when database is reachable', { skip: !process.env.TEST_DATABASE_URL }, async () => {
      const app = buildApp({ dbUrl: process.env['TEST_DATABASE_URL']! });
      const res = await app.request('/readyz');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });
});
