/**
 * SessionStart context injection route — GET /v1/context (DUA-229 M2-GOV-03).
 *
 * Returns a token-budget-controlled markdown summary of recent
 * high/medium-confidence concept pages for agent SessionStart auto-injection.
 *
 * Budget strategy (own value/confidence/freshness policy, NOT simply reusing
 * the concept-list ordering):
 *   1. Sort by confidence DESC (high → medium), then last_confirmed DESC.
 *      Low-confidence concepts are excluded entirely — they do not provide
 *      actionable team knowledge for an agent session.
 *   2. Walk in order; each concept contributes title + one-line body summary
 *      + teamem://concept/<uuid> link. Stop when adding the next concept
 *      would exceed the token budget (~800 tokens ≈ 3200 chars).
 *   3. Report budgetUsed, conceptsIncluded, and conceptsAvailable in the
 *      response metadata.
 *
 * Security / anti-enumeration:
 *   - Cross-team or cross-project access returns empty markdown (identical to
 *     a project with zero concepts) — never a distinguishing 404 or error.
 *   - The response body never contains raw payload, query text, or internal
 *     identifiers beyond concept UUIDs in teamem:// links.
 *   - Concepts already have their bodies redacted (stripPrivateTags ran
 *     before persistence). The markdown is built from persisted concept
 *     fields only.
 *
 * Requires Bearer token with `read` scope.
 */
import { Hono, type Context } from 'hono';
import { and, eq, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  contextRequest,
  contextResponse,
  conceptLink,
  type ContextResponse,
} from '@teamem/schema';
import type { AppDb } from '../../db/client.js';
import * as schema from '../../db/schema.js';
import { requireAuthOrWebSession, requireScope, getAuth } from '../auth.js';
import {
  isProjectScope,
  getTeamId,
  getProjectId,
} from '../../auth/scope.js';
import {
  InvalidRequestError,
  ForbiddenError,
  REQUEST_ID_KEY,
} from '../errors.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum token budget for the rendered markdown (~800 tokens ≈ 3200 chars). */
const TOKEN_BUDGET = 800;
/** Approximate characters-per-token for English text. */
const CHARS_PER_TOKEN = 4;

// ── Dependencies ────────────────────────────────────────────────────────────

export interface ContextRoutesDeps {
  db: AppDb;
}

// ── Types ───────────────────────────────────────────────────────────────────

/** Lightweight concept row for context assembly — only the fields we render. */
interface ContextConceptRow {
  uuid: string;
  type: string;
  path: string;
  title: string;
  body: string;
  confidence: 'high' | 'medium' | 'low';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a one-line summary from a concept body.
 *
 * Takes the first sentence (up to the first `. ` or `.\n`) or the first
 * line, whichever is shorter, capped at 200 characters. Strips markdown
 * heading markers and excessive whitespace.
 */
function extractOneLineSummary(body: string): string {
  // Strip leading/trailing whitespace and heading markers
  const cleaned = body
    .replace(/^#+\s*/gm, '')
    .trim();

  // Try first sentence (ends with period followed by space or newline)
  const sentenceMatch = cleaned.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = sentenceMatch?.[1];
  if (sentence && sentence.length <= 200) {
    return sentence.trim();
  }

  // Fall back to first line or truncation
  const firstLine = cleaned.split('\n')[0]?.trim() ?? cleaned;
  if (firstLine.length <= 200) return firstLine;

  return firstLine.slice(0, 197) + '...';
}

/**
 * Approximate token count from a string using char-based estimation.
 *
 * Uses the standard approximation of ~4 characters per token for English
 * text. This is deliberately approximate — the goal is budget control, not
 * exact billing.
 */
function approxTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build a single concept's markdown entry.
 *
 * Format (DUA-234: includes type and current path for the UI preview):
 *   ## {title}
 *   **{type}** · {path}
 *   {one-line summary}
 *   [View details](teamem://concept/{uuid})
 */
function renderConceptEntry(row: ContextConceptRow): string {
  const summary = extractOneLineSummary(row.body);
  const link = conceptLink(row.uuid);
  return `## ${row.title}\n**${row.type}** · ${row.path}\n${summary}\n\n[View details](${link})\n`;
}

/**
 * Assemble the full context markdown from ordered concept rows.
 *
 * Applies the token budget: appends concepts in order, stopping when the
 * next concept would push the accumulated token count over the budget.
 * Returns the markdown and budget metadata.
 */
function assembleMarkdown(
  rows: ContextConceptRow[],
): { markdown: string; budgetUsed: number; conceptsIncluded: number } {
  // Header — small, fixed cost
  const header = '# Team Context\n\n';
  let markdown = header;
  let tokens = approxTokenCount(markdown);
  let included = 0;

  for (const row of rows) {
    const entry = renderConceptEntry(row);
    const separator = included > 0 ? '\n---\n\n' : '';
    const chunk = separator + entry;
    const chunkTokens = approxTokenCount(chunk);

    // Stop when adding this concept would exceed the budget.
    if (tokens + chunkTokens > TOKEN_BUDGET) break;

    markdown += chunk;
    tokens += chunkTokens;
    included++;
  }

  // If no concepts were included, provide an honest empty summary.
  if (included === 0) {
    const emptyMsg =
      rows.length === 0
        ? '_No high-confidence team knowledge available yet. Concepts are compiled from ingested events — try adding data first._\n'
        : `_${rows.length} concept(s) available but none fit within the ${TOKEN_BUDGET}-token budget. Consider refining your project's concept pages._\n`;
    markdown = header + emptyMsg;
    tokens = approxTokenCount(markdown);
  }

  return { markdown, budgetUsed: tokens, conceptsIncluded: included };
}

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Fetch high/medium-confidence concept rows for a project, ordered by
 * confidence DESC (high first) then last_confirmed DESC.
 *
 * Includes a JOIN to concept_paths (is_current = true) so we only return
 * concepts that actually have a current path.
 */
async function fetchContextConcepts(
  db: AppDb,
  teamId: string,
  projectId: string,
): Promise<ContextConceptRow[]> {
  const rows = await db
    .select({
      uuid: schema.concepts.uuid,
      type: schema.concepts.type,
      path: schema.conceptPaths.path,
      title: schema.concepts.title,
      body: schema.concepts.body,
      confidence: schema.concepts.confidence,
      lastConfirmed: schema.concepts.lastConfirmed,
    })
    .from(schema.concepts)
    .innerJoin(
      schema.conceptPaths,
      and(
        eq(schema.conceptPaths.conceptUuid, schema.concepts.uuid),
        eq(schema.conceptPaths.isCurrent, true),
        eq(schema.conceptPaths.teamId, teamId),
        eq(schema.conceptPaths.projectId, projectId),
      ),
    )
    .where(
      and(
        eq(schema.concepts.teamId, teamId),
        eq(schema.concepts.projectId, projectId),
        or(
          eq(schema.concepts.confidence, 'high'),
          eq(schema.concepts.confidence, 'medium'),
        ),
      ),
    )
    // Confidence DESC: 'high' > 'medium' (alphabetical order works for our enum).
    .orderBy(
      sql`${schema.concepts.confidence} ASC`,
      sql`${schema.concepts.lastConfirmed} DESC`,
    );

  return rows.map((r) => ({
    uuid: r.uuid,
    type: r.type,
    path: r.path,
    title: r.title,
    body: r.body,
    confidence: r.confidence as 'high' | 'medium' | 'low',
  }));
}

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * GET /v1/context?projectId=...
 *
 * Returns a token-budget-controlled markdown summary of the project's
 * high/medium-confidence concept pages.
 */
async function getContextHandler(
  c: Context,
  deps: ContextRoutesDeps,
): Promise<Response> {
  const { db } = deps;
  const auth = getAuth(c);
  const teamId = getTeamId(auth.scope);
  const requestId = c.get(REQUEST_ID_KEY) as string;

  // ── Viewer gate: web session viewer role cannot access context ────────
  // Per AGENTS.md §8, context is a member+ capability. This check applies
  // only to web sessions (API key auth has teamRole = undefined and passes
  // through). We do NOT use read:payload scope as a viewer gate because
  // real API keys with only 'read' scope must still be able to call
  // /v1/search and /v1/context.
  if (auth.teamRole === 'viewer') {
    throw new ForbiddenError();
  }

  // ── Parse & validate query params ─────────────────────────────────────
  const rawProjectId = c.req.query('projectId');
  if (!rawProjectId) {
    throw new InvalidRequestError('projectId query parameter is required');
  }

  const parsed = contextRequest.safeParse({ projectId: rawProjectId });
  if (!parsed.success) {
    throw new InvalidRequestError('Invalid projectId format', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    } as unknown as Record<string, unknown>);
  }

  const { projectId: queryProjectId } = parsed.data;

  // ── Scope enforcement ─────────────────────────────────────────────────
  let effectiveProjectId: string;

  if (isProjectScope(auth.scope)) {
    const keyProjectId = getProjectId(auth.scope);
    if (queryProjectId !== keyProjectId) {
      // Cross-project access within the same team: return empty context,
      // indistinguishable from a project with no concepts (anti-enumeration).
      const empty = assembleMarkdown([]);
      const body: ContextResponse = {
        requestId,
        data: {
          markdown: empty.markdown,
          budgetUsed: empty.budgetUsed,
          conceptsIncluded: empty.conceptsIncluded,
          conceptsAvailable: 0,
        },
      };
      const validated = contextResponse.parse(body);
      return c.json(validated, 200);
    }
    effectiveProjectId = queryProjectId;
  } else {
    // allProjects key — verify the project exists AND belongs to the team.
    // Cross-team access: return empty context (anti-enumeration — same
    // response as a genuinely empty project).
    const projectRows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.teamId, teamId),
          eq(schema.projects.id, queryProjectId),
        ),
      )
      .limit(1);

    if (projectRows.length === 0) {
      const empty = assembleMarkdown([]);
      const body: ContextResponse = {
        requestId,
        data: {
          markdown: empty.markdown,
          budgetUsed: empty.budgetUsed,
          conceptsIncluded: empty.conceptsIncluded,
          conceptsAvailable: 0,
        },
      };
      const validated = contextResponse.parse(body);
      return c.json(validated, 200);
    }
    effectiveProjectId = queryProjectId;
  }

  // ── Fetch & assemble ──────────────────────────────────────────────────
  const conceptRows = await fetchContextConcepts(
    db,
    teamId,
    effectiveProjectId,
  );

  const availableCount = conceptRows.length;
  const assembled = assembleMarkdown(conceptRows);

  const body: ContextResponse = {
    requestId,
    data: {
      markdown: assembled.markdown,
      budgetUsed: assembled.budgetUsed,
      conceptsIncluded: assembled.conceptsIncluded,
      conceptsAvailable: availableCount,
    },
  };

  const validated = contextResponse.parse(body);
  return c.json(validated, 200);
}

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the GET /v1/context route with auth and scope middleware.
 *
 * Usage in app.ts:
 *   app.route('/', buildContextRoutes({ db }));
 */
export function buildContextRoutes(deps: ContextRoutesDeps): Hono {
  const routes = new Hono();

  routes.use('/v1/context', requireAuthOrWebSession(deps.db));
  routes.use('/v1/context', requireScope('read'));
  routes.get('/v1/context', async (c) => {
    return getContextHandler(c, deps);
  });

  return routes;
}
