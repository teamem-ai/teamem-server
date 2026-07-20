/**
 * POST /v1/events/batch — batch ingestion endpoint (M0-ING-04).
 *
 * Accepts up to 500 events in a single request (5 MB body limit), processes
 * them non-atomically, creates one batch compile job, and returns a plain
 * 200 response with per-item accepted/rejected/duplicate results.
 *
 * Never uses HTTP 207 — the contract mandates a single 200 for the whole
 * batch regardless of partial failures (N3).
 */
import { ingestBatchRequest, type IngestBatchResponse } from '@teamem/schema';
import type { Context } from 'hono';
import type { AppDb } from '../../db/client.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import {
  processIngestBatch,
  type ProcessBatchDeps,
} from '../../ingest/ingest-batch.js';
import {
  InvalidRequestError,
  ForbiddenError,
  NotFoundError,
  IdempotencyConflictError,
  PayloadTooLargeError,
  REQUEST_ID_KEY,
} from '../errors.js';
import { IdempotencyConflictError as JobIdempotencyConflictError } from '../../db/repositories/jobs.js';
import { requireAuth, requireScope, getAuth } from '../auth.js';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';

// ── Handler dependencies ────────────────────────────────────────────────────

export interface EventsBatchDeps extends ProcessBatchDeps {
  db: AppDb;
}

// ── Body-size guard ─────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB batch limit (contract ②)

function enforceBodyLimit() {
  return async (c: Context, next: () => Promise<void>) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError(`Body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    await next();
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /v1/events/batch handler.
 *
 * Authenticates via Bearer token, validates the request body against the
 * frozen `ingestBatchRequest` schema, verifies project scope, delegates
 * to processIngestBatch, and returns a plain 200 with per-item results.
 */
export async function postBatchHandler(
  c: Context,
  deps: EventsBatchDeps,
): Promise<Response> {
  const { db } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;

  // ── Step 1: AuthContext from middleware ────────────────────────────────
  const auth = getAuth(c);

  // ── Step 2: Parse & validate request body ──────────────────────────────
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new InvalidRequestError('Request body is not valid JSON');
  }

  const parsed = ingestBatchRequest.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError('Request body validation failed', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  const req = parsed.data;

  // ── Step 3: Scope check — requested project must be within key's scope ─
  const teamId = getTeamId(auth.scope);

  if (isProjectScope(auth.scope)) {
    const keyProjectId = getProjectId(auth.scope);
    if (req.projectId !== keyProjectId) {
      throw new ForbiddenError(
        `API key does not have access to project ${req.projectId}`,
      );
    }
  } else {
    // allProjects key — verify the project exists AND belongs to the key's team.
    const projectRows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.teamId, teamId),
          eq(schema.projects.id, req.projectId),
        ),
      )
      .limit(1);
    if (projectRows.length === 0) {
      throw new NotFoundError(`Project ${req.projectId} not found`);
    }
  }

  // ── Step 4: Process the batch ─────────────────────────────────────────
  try {
    const result = await processIngestBatch(deps, req, teamId, auth, requestId);

    const response: IngestBatchResponse = result.response;

    return c.json(response, 200);
  } catch (err) {
    if (err instanceof JobIdempotencyConflictError) {
      throw new IdempotencyConflictError(
        'idempotency_conflict: same batch key, different payload hash',
        { cause: err },
      );
    }
    throw err;
  }
}

// ── Route registration ──────────────────────────────────────────────────────

import { Hono } from 'hono';

/**
 * Build the POST /v1/events/batch route with all middleware and error handling.
 *
 * The returned Hono instance can be mounted into the main app. Dependencies
 * (db, queue) are injected via the factory parameter.
 */
export function buildEventsBatchRoutes(deps: EventsBatchDeps): Hono {
  const routes = new Hono();

  // Middleware chain: body limit → auth → scope → handler
  routes.use('/v1/events/batch', enforceBodyLimit());
  routes.use('/v1/events/batch', requireAuth(deps.db));
  routes.use('/v1/events/batch', requireScope('events:write'));
  routes.post('/v1/events/batch', async (c) => {
    return postBatchHandler(c, deps);
  });

  return routes;
}
