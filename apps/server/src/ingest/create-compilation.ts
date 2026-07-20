/**
 * POST /v1/compilations — explicit compilation endpoint (M0-ING-05).
 *
 * Accepts a set of event IDs with a mandatory idempotency key, looks them
 * up within the authenticated project scope, and creates a compilation job
 * for eligible events. Returns per-event status:
 *   queued | already_active | already_compiled | not_found
 *
 * Idempotency (N1): same (project, kind='compilation', idempotencyKey) +
 * same request hash replays the original compilationJobId and result snapshot.
 *
 * Pipeline is always scoped by team_id + project_id (red line 5.5).
 */
import { compilationRequest, type CompilationResponse } from '@teamem/schema';
import type { Context } from 'hono';
import type { AppDb } from '../db/client.js';
import { getEventsByIds } from '../db/repositories/events.js';
import {
  createJob,
  findJobByIdempotencyKey,
  upsertJobEvent,
  getEventCompilationStatus,
  IdempotencyConflictError as JobIdempotencyConflictError,
} from '../db/repositories/jobs.js';
import { isProjectScope, getTeamId, getProjectId } from '../auth/scope.js';
import { payloadHash } from '../security/payload-hash.js';
import {
  InvalidRequestError,
  ForbiddenError,
  NotFoundError,
  InternalError,
  IdempotencyConflictError,
  REQUEST_ID_KEY,
} from '../http/errors.js';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { requireAuth, requireScope, getAuth } from '../http/auth.js';
import type { CompileQueue } from '../queue/boss.js';
import { enqueueCompilation } from '../queue/enqueue-compilation.js';

// ── Handler dependencies ────────────────────────────────────────────────────

export interface CreateCompilationDeps {
  db: AppDb;
  queue?: CompileQueue;
}

// ── Helper: stored snapshot shape for idempotent replay ────────────────────
// We store only the per-event results; the full CompilationResponse is
// reconstructed at replay time with the job's UUID and the current requestId.

interface CompilationSnapshot {
  results: Array<{ eventId: string; status: string }>;
}

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /v1/compilations handler.
 *
 * Authenticates via Bearer token, validates the request body against the
 * frozen `compilationRequest` schema, looks up events within scope,
 * classifies each event, creates a compilation job idempotently, and
 * returns the per-event status list.
 */
export async function postCompilationsHandler(
  c: Context,
  deps: CreateCompilationDeps,
): Promise<Response> {
  const { db, queue } = deps;
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

  const parsed = compilationRequest.safeParse(body);
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

  // ── Step 4: Compute idempotency request hash ───────────────────────────
  const idempotencyRequestHash = payloadHash(req);

  // ── Step 5: Check for idempotent replay ────────────────────────────────
  const existingJob = await findJobByIdempotencyKey(
    db,
    teamId,
    req.projectId,
    'compilation',
    req.idempotencyKey,
  );

  if (existingJob) {
    if (
      existingJob.idempotencyRequestHash === idempotencyRequestHash
    ) {
      // Idempotent replay — reconstruct the response from stored snapshot.
      const snapshot = existingJob.resultSnapshot as CompilationSnapshot | null;
      const results = snapshot?.results ?? [];
      const response: CompilationResponse = {
        requestId,
        compilationJobId: existingJob.id,
        duplicate: true,
        results: results as CompilationResponse['results'],
      };
      return c.json(response, 200);
    }
    // Different hash → conflict.
    throw new IdempotencyConflictError(
      'idempotency_conflict: same key, different request hash',
      { cause: new JobIdempotencyConflictError(existingJob.id) },
    );
  }

  // ── Step 6: Look up events within project scope ────────────────────────
  const foundEvents = await getEventsByIds(
    db,
    teamId,
    req.projectId,
    req.eventIds,
  );

  const foundEventIds = new Set(foundEvents.map((e) => e.id));

  // ── Step 7: Determine per-event compilation status ─────────────────────
  const { activeEventIds, compiledEventIds } =
    await getEventCompilationStatus(db, teamId, req.projectId, req.eventIds);

  // Classify each requested event.
  const results: Array<{ eventId: string; status: string }> = [];
  const queuedEventIds: string[] = [];

  for (const eventId of req.eventIds) {
    if (!foundEventIds.has(eventId)) {
      results.push({ eventId, status: 'not_found' });
    } else if (activeEventIds.has(eventId)) {
      results.push({ eventId, status: 'already_active' });
    } else if (compiledEventIds.has(eventId)) {
      results.push({ eventId, status: 'already_compiled' });
    } else {
      results.push({ eventId, status: 'queued' });
      queuedEventIds.push(eventId);
    }
  }

  // ── Step 8: Create the compilation job ─────────────────────────────────
  const snapshot: CompilationSnapshot = { results };

  let compilationJobId: string;

  if (queuedEventIds.length === 0) {
    // No events to compile — create a job row (still needed for idempotency)
    // and immediately mark it completed. No pg-boss message is sent.
    try {
      const { job, created } = await createJob(db, {
        teamId,
        projectId: req.projectId,
        kind: 'compilation',
        initiatedByKind: 'credential',
        initiatedByCredentialId: auth.credentialId,
        initiatedByPrincipalId: auth.principal?.id ?? null,
        idempotencyKey: req.idempotencyKey,
        idempotencyRequestHash,
        resultSnapshot: snapshot,
        eventCount: req.eventIds.length,
      });

      compilationJobId = job.id;

      if (created) {
        // No real compilation to run — mark done.
        await db
          .update(schema.jobs)
          .set({ status: 'completed', finishedAt: new Date() })
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.teamId, teamId),
              eq(schema.jobs.projectId, req.projectId),
            ),
          );
      }
    } catch (err) {
      if (err instanceof JobIdempotencyConflictError) {
        throw new IdempotencyConflictError(
          'idempotency_conflict: same key, different request hash',
          { cause: err },
        );
      }
      throw new InternalError('Failed to create compilation job', {
        cause: err,
      });
    }
  } else {
    // Create the compilation job. When a queue is available, use the full
    // enqueueCompilation pipeline (job + per-event rows + pg-boss message).
    // When no queue is available (e.g. tests), create the job without
    // enqueuing — the job row exists and can be picked up later.
    try {
      if (queue) {
        const result = await enqueueCompilation(db, queue, {
          teamId,
          projectId: req.projectId,
          kind: 'compilation',
          eventIds: queuedEventIds,
          initiatedByKind: 'credential',
          initiatedByCredentialId: auth.credentialId,
          initiatedByPrincipalId: auth.principal?.id ?? null,
          idempotencyKey: req.idempotencyKey,
          idempotencyRequestHash,
          resultSnapshot: snapshot,
        });
        compilationJobId = result.jobId;
      } else {
        // No queue — create the job row directly (test / dev path).
        const { job } = await createJob(db, {
          teamId,
          projectId: req.projectId,
          kind: 'compilation',
          initiatedByKind: 'credential',
          initiatedByCredentialId: auth.credentialId,
          initiatedByPrincipalId: auth.principal?.id ?? null,
          idempotencyKey: req.idempotencyKey,
          idempotencyRequestHash,
          resultSnapshot: snapshot,
          eventCount: queuedEventIds.length,
        });
        compilationJobId = job.id;

        // Upsert per-event rows so the worker can find them later.
        for (const eventId of queuedEventIds) {
          try {
            await upsertJobEvent(db, {
              teamId,
              projectId: req.projectId,
              jobId: job.id,
              eventId,
              status: 'pending',
            });
          } catch {
            // Best-effort.
          }
        }
      }
    } catch (err) {
      if (err instanceof JobIdempotencyConflictError) {
        throw new IdempotencyConflictError(
          'idempotency_conflict: same key, different request hash',
          { cause: err },
        );
      }
      throw new InternalError('Failed to create compilation job', {
        cause: err,
      });
    }
  }

  // ── Step 9: Return the response ────────────────────────────────────────
  const response: CompilationResponse = {
    requestId,
    compilationJobId,
    duplicate: false,
    results: results as CompilationResponse['results'],
  };

  return c.json(response, 200);
}

// ── Body-size guard ─────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

function enforceBodyLimit() {
  return async (c: Context, next: () => Promise<void>) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      throw new InvalidRequestError(`Body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    await next();
  };
}

// ── Route registration ──────────────────────────────────────────────────────

import { Hono } from 'hono';

/**
 * Build the POST /v1/compilations route with all middleware and error handling.
 */
export function buildCompilationsRoutes(deps: CreateCompilationDeps): Hono {
  const routes = new Hono();

  routes.use('/v1/compilations', enforceBodyLimit());
  routes.use('/v1/compilations', requireAuth(deps.db));
  routes.use('/v1/compilations', requireScope('events:write'));
  routes.post('/v1/compilations', async (c) => {
    return postCompilationsHandler(c, deps);
  });

  return routes;
}
