/**
 * OKF export download endpoint — GET /v1/export (DUA-251 / M3-EXPORT-04).
 *
 * Packages the rendered whole-project OKF bundle (M3-EXPORT-03) behind a
 * scope/role-gated download endpoint:
 *
 *   GET /v1/export?projectId=prj_...  →  200 application/gzip
 *        (attachment: <slug>-okf-<version>.tar.gz)
 *
 * The archive contains the deterministic bundle file tree: `index.md`
 * catalog, `log.md` change log, and one concept page per concept under its
 * frozen per-type directory.
 *
 * Access control (AGENTS.md §8 + §5.5):
 *   - API key: `read` scope (requireScope) AND project scope — a
 *     project-bound key may only ever download its own project; a
 *     team-wide (`allProjects`) key must name a project that exists AND
 *     belongs to the key's team.
 *   - Web session: member+ role. Viewer is denied with the identical 403
 *     envelope used by every other member+ capability (search/context):
 *     the viewer gate is applied only when `auth.teamRole === 'viewer'`,
 *     which exists exclusively on web-session auth — API keys pass through
 *     with their `read` scope check, so a real API key with only `read`
 *     can still download (mirrors the POST /v1/search gate).
 *   - Cross-team and genuinely missing projects are indistinguishable: both
 *     render `null` from the scoped repository and both return the same
 *     404 envelope (anti-enumeration, §5.5/§8).
 *
 * Auditing (N7 / AGENTS.md §6.3):
 *   - A successful download writes an `export.download` audit record with
 *     whitelisted metadata only (requestId, actor, credential, team,
 *     project id, outcome) — never bundle content, query text, or payload.
 *   - Fail-closed on success: if the audit write fails, the download is
 *     denied (500, `audit_failed: true`) — a bulk knowledge read must not
 *     go unrecorded.
 *   - Scope-denied/missing probes write a best-effort `denied` record,
 *     mirroring the search use case. The audit table has no content
 *     columns, so nothing about the bundle can leak through it.
 *
 * Response notes:
 *   - `Content-Disposition` filename is derived from the project name,
 *     sanitized to `[a-z0-9-]` (fallback `project` + project id); the
 *     response is a binary archive, not an error envelope.
 *   - Unknown query parameters are rejected (400) so the contract stays
 *     tight — the only accepted input is `projectId`.
 */
import { Hono, type Context } from 'hono';
import { projectId as projectIdSchema, OKF_FORMAT_VERSION } from '@teamem/schema';
import type { AppDb } from '../../db/client.js';
import { requireAuthOrWebSession, requireScope, getAuth } from '../auth.js';
import {
  isProjectScope,
  getTeamId,
  getProjectId,
} from '../../auth/scope.js';
import { renderOkfBundle } from '../../export/render-okf-bundle.js';
import { buildOkfTarGz, ArchiveError } from '../../export/archive.js';
import { writeAuditRecord } from '../../db/repositories/audit.js';
import {
  InvalidRequestError,
  ForbiddenError,
  NotFoundError,
  InternalError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface ExportRoutesDeps {
  db: AppDb;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitize the project name into a URL-safe download filename slug:
 * lowercase, runs of non-alphanumerics → single dash, no leading/trailing
 * dash. Falls back to the (already safe) project id when the name has no
 * usable characters.
 */
function downloadFilename(projectName: string, projectId: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || projectId}-okf-${OKF_FORMAT_VERSION}.tar.gz`;
}

// ── Handler: GET /v1/export ────────────────────────────────────────────────

async function getExportHandler(c: Context, deps: ExportRoutesDeps): Promise<Response> {
  const { db } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;
  const auth = getAuth(c);
  const teamId = getTeamId(auth.scope);

  // ── Viewer gate: web session viewer role cannot download exports ──────
  // Mirrors the POST /v1/search gate: teamRole exists only on web-session
  // auth (API keys have teamRole undefined and pass through to the read
  // scope check), so this never downgrades a real API key.
  if (auth.teamRole === 'viewer') {
    throw new ForbiddenError();
  }

  // ── Strict query surface: only `projectId` is accepted ───────────────
  const unknownKeys = Object.keys(c.req.queries()).filter((k) => k !== 'projectId');
  if (unknownKeys.length > 0) {
    throw new InvalidRequestError(
      `Unrecognized query parameter(s): ${unknownKeys.join(', ')}`,
    );
  }

  // ── Resolve the project within the caller's scope ────────────────────
  let projectId: string;
  if (isProjectScope(auth.scope)) {
    // Project-bound key (or project-bound scope): the key's project is the
    // only project it can ever download. A conflicting query param is
    // either malformed (400) or out of scope (403).
    projectId = getProjectId(auth.scope);
    const rawQuery = c.req.query('projectId');
    if (rawQuery !== undefined) {
      const parsed = projectIdSchema.safeParse(rawQuery);
      if (!parsed.success) {
        throw new InvalidRequestError('Invalid projectId format');
      }
      if (parsed.data !== projectId) {
        throw new ForbiddenError(
          `API key does not have access to project ${parsed.data}`,
        );
      }
    }
  } else {
    // allProjects scope (team-wide API key OR web session): must name a
    // project explicitly; existence + team membership are validated by the
    // scoped repository below (404, indistinguishable from missing).
    const rawQuery = c.req.query('projectId');
    if (rawQuery === undefined || rawQuery === '') {
      throw new InvalidRequestError(
        'projectId query parameter is required for team-wide access',
      );
    }
    const parsed = projectIdSchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new InvalidRequestError('Invalid projectId format');
    }
    projectId = parsed.data;
  }

  // ── Render the scoped bundle (the ONLY data path; scope-enforcing) ───
  // null is returned for BOTH a missing project and another team's project
  // — one identical 404, no enumeration.
  const result = await renderOkfBundle(
    db,
    auth.scope,
    isProjectScope(auth.scope) ? {} : { projectId },
  );

  if (result === null) {
    // Best-effort denied audit — metadata only (projectId is not secret
    // content). Never blocks the 404 response.
    await writeAuditRecord(db, {
      requestId,
      principalId: auth.principal?.id ?? null,
      credentialId: auth.credentialId,
      action: 'export.download',
      resourceType: 'project',
      resourceId: projectId,
      teamId,
      projectId,
      outcome: 'denied',
    }).catch(() => {});
    throw new NotFoundError();
  }

  // ── Package the bundle into the deterministic .tar.gz archive ────────
  let archive: Buffer;
  try {
    archive = buildOkfTarGz(result.files);
  } catch (err) {
    if (err instanceof ArchiveError) {
      // The rendered tree is corrupt (unsafe/unrepresentable path) —
      // fail loudly; never emit a partial or silently-trimmed archive.
      console.error(
        JSON.stringify({
          event: 'export_archive_failed',
          requestId,
          projectId: result.project.id,
        }),
      );
      throw new InternalError('Export archive could not be built', {
        cause: err,
        details: { archive_failed: true },
      });
    }
    throw err;
  }

  // ── Fail-closed success audit (N7): a bulk knowledge read must be
  //    recorded; an audit failure denies the download. ────────────────
  try {
    await writeAuditRecord(db, {
      requestId,
      principalId: auth.principal?.id ?? null,
      credentialId: auth.credentialId,
      action: 'export.download',
      resourceType: 'project',
      resourceId: projectId,
      teamId,
      projectId,
      outcome: 'success',
    });
  } catch (err) {
    throw new InternalError('Export audit failed; download denied', {
      cause: err,
      details: { audit_failed: true },
    });
  }

  // ── Stream the binary response ────────────────────────────────────────
  c.header('Content-Type', 'application/gzip');
  c.header(
    'Content-Disposition',
    `attachment; filename="${downloadFilename(result.project.name, result.project.id)}"`,
  );
  c.header('Content-Length', String(archive.length));
  c.header('Cache-Control', 'no-store');
  return c.body(archive as never);
}

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the GET /v1/export route with auth and scope middleware.
 *
 * Usage in app.ts:
 *   app.route('/', buildExportRoutes({ db }));
 */
export function buildExportRoutes(deps: ExportRoutesDeps): Hono {
  const routes = new Hono();

  // Authentication: Bearer API key OR web session cookie.
  // Authorisation: `read` scope (API keys); member+ for web sessions is
  // enforced in the handler via the viewer gate (identical 403).
  routes.use('/v1/export', requireAuthOrWebSession(deps.db));
  routes.use('/v1/export', requireScope('read'));
  routes.get('/v1/export', async (c) => getExportHandler(c, deps));

  return routes;
}