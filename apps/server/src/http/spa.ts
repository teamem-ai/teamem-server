/**
 * SPA (Single-Page Application) static-file serving middleware.
 *
 * In production the teamem server hosts the React web SPA directly on the
 * same port — no separate web container.  This middleware serves the Vite
 * build output (apps/web/dist) and falls back to index.html for any path
 * that does not match a file, so client-side routing (react-router-dom)
 * boots correctly for deep links like /knowledge or /settings/keys.
 *
 * API routes are mounted *before* this middleware in buildApp(), so
 * requests matching /v1, /auth, /healthz, /readyz, /invites, /teams,
 * /mcp, or /e2e are never intercepted by the SPA fallback.
 *
 * Mounted routes take precedence, but an *unknown* path under an API
 * prefix (e.g. GET /v1/nonexistent) matches no API route and would fall
 * through to this middleware. Serving index.html for it would turn an
 * API 404 into a 200 and break the frozen error contract, so every known
 * API/control prefix is also excluded here: those requests fall through
 * to the app's notFound handler (404 with the error envelope). The SPA
 * fallback only serves client-side routes that are not under an API
 * prefix (e.g. /knowledge, /settings/keys).
 *
 * Security: the middleware refuses paths containing '..' and only serves
 * files inside the resolved dist directory — no directory traversal.
 */
import { type Context, type Next } from 'hono';
import { readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, extname } from 'node:path';

// API / control prefixes the SPA must never serve — including unknown
// sub-paths, which belong to the API 404 contract, not client-side routing.
const API_PREFIXES = ['/v1', '/mcp', '/auth', '/healthz', '/readyz', '/invites', '/teams', '/__e2e'];

// ── MIME map ───────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

// ── Resolve the dist directory ─────────────────────────────────────────────

function resolveDistDir(): string | null {
  // Explicit override (e.g. mounted volume in Compose).
  const envPath = process.env['TEAMEM_WEB_DIST_PATH'];
  if (envPath) return resolve(envPath);

  // Docker production layout: WORKDIR=/app, web dist copied to apps/web/dist.
  const dockerPath = resolve(process.cwd(), 'apps', 'web', 'dist');
  return dockerPath;
}

// ── Safe path lookup ───────────────────────────────────────────────────────

function safePath(distDir: string, requestPath: string): string | null {
  // Normalise and reject traversal attempts.
  const decoded = decodeURIComponent(requestPath.split('?')[0]!);
  const normalised = normalize(decoded);
  if (normalised.includes('..')) return null;

  const absolute = join(distDir, normalised === '/' ? 'index.html' : normalised);
  if (!absolute.startsWith(resolve(distDir) + '/') && absolute !== resolve(distDir)) {
    return null;
  }
  return absolute;
}

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * SPA serve middleware: tries to serve a static file matching the request
 * path, then falls back to index.html for SPA client-side routing.
 *
 * Routes mounted above this middleware (API, auth, health, etc.) take
 * precedence — only requests that do not match an earlier route reach here.
 */
export function createSpaMiddleware() {
  const distDir = resolveDistDir();

  return async (c: Context, next: Next) => {
    // Only serve GET/HEAD for SPA — POST/PUT/DELETE fall through
    // to the 404 handler.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return next();
    }

    // Never serve the SPA for API/control paths — including unknown
    // /v1, /mcp, /auth … sub-paths that matched no route. They must reach
    // the notFound handler (404 with the error envelope) per the frozen
    // error contract, not be masked as an HTML 200 by client-side routing.
    const requestPath = c.req.path;
    for (const prefix of API_PREFIXES) {
      if (requestPath === prefix || requestPath.startsWith(prefix + '/')) {
        return next();
      }
    }

    if (!distDir) {
      return next();
    }

    // ── Attempt static file ────────────────────────────────────────────
    const filePath = safePath(distDir, requestPath);

    if (filePath) {
      try {
        const s = await stat(filePath);
        if (s.isFile()) {
          const ext = extname(filePath).toLowerCase();
          const mime = MIME[ext] ?? 'application/octet-stream';

          c.header('Content-Type', mime);
          // HTML must be no-store, not just no-cache: no-cache still lets
          // the browser back/forward cache (bfcache) restore the full
          // in-memory page — DOM, JS heap, everything — on a back/forward
          // navigation with zero network request, which would show
          // protected content after logout even though the server-side
          // session is genuinely gone. no-store is one of the documented
          // conditions that makes a page bfcache-ineligible. Hashed JS/CSS
          // assets are unaffected — those keep aggressive immutable caching.
          c.header('Cache-Control', ext === '.html'
            ? 'no-store'
            : 'public, max-age=604800, immutable');

          // Read into a buffer — avoids streaming-related async cleanup
          // races when the dist directory is on a short-lived volume.
          const body = await readFile(filePath);
          return c.body(body as never);
        }
      } catch {
        // File doesn't exist — fall through to SPA fallback.
      }
    }

    // ── SPA fallback: serve index.html for any non-file path ───────────
    const indexPath = safePath(distDir, '/index.html');
    if (indexPath) {
      try {
        const s = await stat(indexPath);
        if (s.isFile()) {
          c.header('Content-Type', 'text/html; charset=utf-8');
          // See the comment on the static-file branch above — no-store,
          // not no-cache, so protected pages are never restorable from
          // bfcache after logout.
          c.header('Cache-Control', 'no-store');
          const body = await readFile(indexPath);
          return c.body(body as never);
        }
      } catch {
        // index.html doesn't exist — let the 404 handler respond.
      }
    }

    return next();
  };
}
