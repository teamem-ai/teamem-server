/**
 * MCP get_page tool — Progressive Disclosure L2 (DUA-208).
 *
 * Returns the full concept page detail (body + type/status/confidence +
 * evidence with permalinks) for a given UUID.  Uses scoped SQL directly
 * via getConceptByUuid — never fetches first and authorizes later.
 *
 * Cross-team access returns the same "Concept not found" error as a
 * genuinely missing UUID (anti-enumeration).  Every read (success or
 * denied) writes an audit record.
 */
import { z } from 'zod';
import { conceptUuid } from '@teamem/schema';
import { getConceptByUuid } from '../../db/repositories/concepts-read.js';
import { writeAuditRecord } from '../../db/repositories/audit.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import type { McpTool, ToolHandler, ToolResult } from '../registry.js';

// ── Tool metadata ───────────────────────────────────────────────────────────

export const getPageTool: McpTool = {
  name: 'get_page',
  description:
    'Get a concept page by UUID with full details: body, type, status, ' +
    'confidence, contributors, evidence links (PR/commit permalinks), ' +
    'and aliases.  Use after search to drill into a specific concept.',
  inputSchema: {
    type: 'object',
    properties: {
      uuid: {
        type: 'string',
        description: 'The canonical UUID of the concept page to retrieve.',
        format: 'uuid',
      },
    },
    required: ['uuid'],
  },
};

// ── Tool args schema ────────────────────────────────────────────────────────

const getPageArgsSchema = z.object({
  uuid: conceptUuid,
});

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * get_page tool handler.
 *
 * 1. Validates the uuid argument against conceptUuid.
 * 2. Derives scope from the AuthContext (project-scoped key required).
 * 3. Calls getConceptByUuid — scoped SQL directly, no fetch-then-auth.
 * 4. Writes an audit record (success or denied).
 * 5. Returns the full Concept as JSON, or an isError result with
 *    "Concept not found" (identical for cross-team and missing).
 */
export const getPageHandler: ToolHandler = async (
  args,
  ctx,
): Promise<ToolResult> => {
  // ── Validate arguments ──────────────────────────────────────────────
  const parsed = getPageArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        },
      ],
      isError: true,
    };
  }

  const { uuid } = parsed.data;
  const { db, auth, requestId } = ctx;

  // ── Derive scope ────────────────────────────────────────────────────
  // get_page requires a project-scoped key.  allProjects keys are not
  // supported because the tool has no project_id argument — the scope is
  // derived entirely from the API key.
  if (!isProjectScope(auth.scope)) {
    return {
      content: [
        {
          type: 'text',
          text: 'get_page requires a project-scoped API key',
        },
      ],
      isError: true,
    };
  }

  const teamId = getTeamId(auth.scope);
  const projectId = getProjectId(auth.scope);

  // ── Fetch concept (scoped SQL) ─────────────────────────────────────
  const concept = await getConceptByUuid(db, teamId, projectId, uuid);

  if (!concept) {
    // Audit the denied read (best-effort — do not block the response).
    await writeAuditRecord(db, {
      requestId,
      principalId: auth.principal?.id ?? null,
      credentialId: auth.credentialId,
      action: 'concept.read',
      resourceType: 'concept',
      resourceId: uuid,
      teamId,
      projectId,
      outcome: 'denied',
    }).catch(() => {});

    return {
      content: [{ type: 'text', text: 'Concept not found' }],
      isError: true,
    };
  }

  // ── Audit successful read ──────────────────────────────────────────
  await writeAuditRecord(db, {
    requestId,
    principalId: auth.principal?.id ?? null,
    credentialId: auth.credentialId,
    action: 'concept.read',
    resourceType: 'concept',
    resourceId: uuid,
    teamId,
    projectId,
    outcome: 'success',
  }).catch(() => {});

  // ── Return full concept as formatted JSON ──────────────────────────
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(concept, null, 2),
      },
    ],
  };
};
