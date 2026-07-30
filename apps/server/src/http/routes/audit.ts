/**
 * GET /v1/audit — audit query API (DUA-227 M2-GOV-01).
 *
 * Lists audit records with metadata-only columns (no content/payload/query
 * text is ever returned). Supports filtering by actor, action, projectId,
 * and cursor-based pagination (created_at DESC, id DESC).
 *
 * Access control:
 *   - Requires a valid web session cookie (not an API key — audit is a
 *     management capability, per the contract's admin-only rule).
 *   - Requires admin or owner role; viewer and member are denied (403).
 *   - Users without team membership see an empty list (200), matching
 *     the anti-enumeration rule: cross-team probes and missing teams are
 *     indistinguishable.
 *   - Audit queries themselves are NOT re-audited (one-level audit, N7).
 *
 * The response DTO is the frozen @teamem/schema auditListResponse — every
 * row carries ONLY the whitelisted columns: id, createdAt, requestId,
 * principalId, credentialId, action, resourceType, resourceId, teamId,
 * projectId, outcome. No request bodies, query text, payloads, keys, or
 * secrets ever appear in these results.
 */
import { Hono, type Context } from 'hono';
import {
  auditListQuery,
  auditListResponse,
  type AuditItem,
} from '@teamem/schema';
import type { AppDb } from '../../db/client.js';
import type { GitHubOAuthConfig } from '../../auth/oauth-github.js';
import {
  listAuditRecords,
  type AuditRow,
} from '../../db/repositories/audit.js';
import {
  requireSession,
  getSession,
} from './auth.js';
import {
  InvalidRequestError,
  ForbiddenError,
  CursorInvalidError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── Handler dependencies ────────────────────────────────────────────────────

export interface AuditRoutesDeps {
  db: AppDb;
  oauthConfig: GitHubOAuthConfig;
}

// ── DTO mapping ─────────────────────────────────────────────────────────────

/**
 * Map a database AuditRow to the wire AuditItem DTO.
 *
 * The row already contains ONLY whitelisted columns — this function is a
 * straightforward field mapping. No sensitive content can appear because
 * the database table has no content columns and the repository never selects
 * from tables that might contain payload/query text.
 */
function toAuditItem(row: AuditRow): AuditItem {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    requestId: row.requestId,
    principalId: row.principalId,
    credentialId: row.credentialId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    teamId: row.teamId,
    projectId: row.projectId,
    outcome: row.outcome,
  };
}

// ── GET /v1/audit handler ──────────────────────────────────────────────────

async function getAuditListHandler(
  c: Context,
  deps: AuditRoutesDeps,
): Promise<Response> {
  const { db } = deps;
  const requestId = c.get(REQUEST_ID_KEY) as string;
  const session = getSession(c);

  // Role enforcement: admin+ only. Users without a team membership
  // (session.role === null) get an empty list (anti-enumeration —
  // indistinguishable from a genuinely empty audit log).
  if (!session.role) {
    // No team membership — return empty list (not 403, not 404).
    // A user without a team is not inherently "less privileged";
    // they just have nothing to see.
    const response = auditListResponse.parse({
      requestId,
      data: [],
      nextCursor: null,
    });
    return c.json(response, 200);
  }

  if (session.role !== 'admin' && session.role !== 'owner') {
    // Identical 403 regardless of actual role (viewer / member) —
    // no role enumeration.
    throw new ForbiddenError('Insufficient role');
  }

  // session.teamId must exist for admin+ users (they have a membership).
  const teamId = session.teamId;
  if (!teamId) {
    // Should not happen for admin/owner, but handle gracefully.
    const response = auditListResponse.parse({
      requestId,
      data: [],
      nextCursor: null,
    });
    return c.json(response, 200);
  }

  // Parse query parameters against the frozen contract.
  const rawQuery = {
    projectId: c.req.query('projectId') || undefined,
    actor: c.req.query('actor') || undefined,
    action: c.req.query('action') || undefined,
    cursor: c.req.query('cursor') || undefined,
    limit: c.req.query('limit'),
  };

  const parsed = auditListQuery.safeParse(rawQuery);
  if (!parsed.success) {
    throw new InvalidRequestError('Invalid query parameters', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  const { projectId, actor, action, cursor, limit } = parsed.data;

  // Query the audit log with scope and filters.
  let result;
  try {
    result = await listAuditRecords(db, {
      teamId,
      projectId,
      actor,
      action,
      cursor,
      limit,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'cursor_invalid') {
      throw new CursorInvalidError();
    }
    throw err;
  }

  // Map rows to DTOs.
  const items = result.rows.map(toAuditItem);

  // Validate response shape against the frozen contract.
  const response = auditListResponse.parse({
    requestId,
    data: items,
    nextCursor: result.nextCursor,
  });

  return c.json(response, 200);
}

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the GET /v1/audit route.
 *
 * Requires: valid web session (NOT API key — audit is a management
 * capability). Role enforcement (admin/owner) is performed in the
 * handler so that users without team membership see an empty list
 * rather than a distinguishing error response.
 */
export function buildAuditRoutes(deps: AuditRoutesDeps): Hono {
  const routes = new Hono();

  // Web session required (NOT API key — audit is a management capability).
  routes.use('/v1/audit', requireSession(deps.oauthConfig, deps.db));

  routes.get('/v1/audit', async (c) => getAuditListHandler(c, deps));

  return routes;
}
