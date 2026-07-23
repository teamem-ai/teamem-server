/**
 * POST /v1/search route handler (DUA-205 M1-SR-03).
 *
 * HTTP route for the search endpoint:
 *   POST /v1/search  — scoped text/semantic search
 *
 * Requires Bearer token with `read` scope.  All responses conform to the
 * frozen `searchResponse` DTO from `@teamem/schema`.
 *
 * Scope enforcement (delegated entirely to the search use case, DUA-204
 * M1-SR-02):
 * - Project-scoped key: projectId is validated against the key's scope.
 *   Cross-project access returns empty results (anti-enumeration) — never
 *   a distinguishing error, per AGENTS.md §5.5/§8.
 * - allProjects key: the projectId in the body must be a valid project
 *   belonging to the key's team; otherwise empty results are returned.
 */
import { Hono, type Context } from 'hono';
import { searchRequest, searchResponse } from '@teamem/schema';
import type { AppDb } from '../../db/client.js';
import type { EmbeddingClient } from '../../llm/embedding/port.js';
import { requireAuth, requireScope, getAuth } from '../auth.js';
import {
  search,
  SearchUseCaseError,
  type SearchContext,
} from '../../search/search-use-case.js';
import {
  InvalidRequestError,
  CursorInvalidError,
  InternalError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface SearchRoutesDeps {
  db: AppDb;
  /** Optional embedding client for hybrid (vector + FTS) search. */
  embeddingClient?: EmbeddingClient | null;
}

// ── Handler: POST /v1/search ───────────────────────────────────────────────

export async function postSearchHandler(c: Context, deps: SearchRoutesDeps): Promise<Response> {
  const { db } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;

  const auth = getAuth(c);

  // ── Parse & validate request body against the frozen contract ─────────
  const rawBody = await c.req.json().catch(() => ({}));

  // Explicit limit check: the Zod schema enforces max 100, but we check
  // here first so the error response can include the max value in a
  // human-readable way (DUA-205 requirement: response must indicate max=100).
  if (typeof rawBody?.limit === 'number' && rawBody.limit > 100) {
    throw new InvalidRequestError('limit must not exceed 100', {
      field: 'limit',
      max: '100',
      provided: String(rawBody.limit),
    });
  }

  const parsed = searchRequest.safeParse(rawBody);

  if (!parsed.success) {
    // Format Zod issues as string-valued details so they survive safeDetails.
    const details: Record<string, string> = {};
    const issues = parsed.error.issues;
    if (issues.length > 0) {
      const formatted = issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      details['validation'] = formatted;
    }
    throw new InvalidRequestError('Invalid search request body', details);
  }

  const request = parsed.data;

  // ── Build context from auth ──────────────────────────────────────────
  // No HTTP-layer scope pre-check: cross-project/cross-team access must be
  // indistinguishable from a project with zero matches (AGENTS.md §5.5, §8).
  // The use case enforces scope and returns an empty, degraded result for
  // any scope mismatch — never a distinguishing error.
  const searchContext: SearchContext = {
    requestId,
    credentialId: auth.credentialId,
    principalId: auth.principal?.id ?? null,
  };

  // ── Execute the use case ─────────────────────────────────────────────
  let response;
  try {
    response = await search(db, auth.scope, request, searchContext, deps.embeddingClient);
  } catch (err) {
    if (err instanceof SearchUseCaseError) {
      if (err.code === 'cursor_invalid') {
        throw new CursorInvalidError();
      }
      throw new InternalError('Search failed', { cause: err });
    }
    throw new InternalError('Search failed', { cause: err });
  }

  // ── Validate the response shape against the frozen contract ──────────
  // (search() already returns the correct shape, but this is a safety net)
  const validated = searchResponse.safeParse(response);
  if (!validated.success) {
    console.error(
      JSON.stringify({
        event: 'search_response_validation_failed',
        requestId,
        issues: validated.error.issues,
      }),
    );
    throw new InternalError('Search response validation failed');
  }

  return c.json(validated.data, 200);
}

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the POST /v1/search route with auth and scope middleware.
 *
 * Usage in app.ts:
 *   app.route('/', buildSearchRoutes({ db }));
 */
export function buildSearchRoutes(deps: SearchRoutesDeps): Hono {
  const routes = new Hono();

  routes.use('/v1/search', requireAuth(deps.db));
  routes.use('/v1/search', requireScope('read'));
  routes.post('/v1/search', async (c) => postSearchHandler(c, deps));

  return routes;
}
