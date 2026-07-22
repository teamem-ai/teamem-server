/**
 * MCP memory_write tool (DUA-210 M1-MCP-05).
 *
 * Registers the `memory_write` tool that lets an agent session actively
 * store "dead-end / no-diff decisions" as mcp_write events. The server
 * internally constructs an mcp_write event (channel=mcp, server-generated
 * UUID deliveryId), runs it through the standard ingestion pipeline
 * (validate → stripPrivateTags → persist → enqueue), and returns the
 * event id to the caller.
 *
 * The tool reuses the same insertEvent / createJob / queue.send pipeline
 * as the GitHub connector and CLI init, ensuring identical red-line
 * enforcement (redaction, scope, idempotency).
 *
 * Repeated writes with identical content are NOT deduplicated by content
 * hash — they go to F2 semantic merging. Each invocation generates a
 * fresh deliveryId UUID, so independent writes with the same content
 * are distinct events (per the task spec).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PAYLOAD_SCHEMA_VERSION, EVENT_ENVELOPE_VERSION } from '@teamem/schema';
import type { ToolRegistry, ToolExecutionContext, ToolResult } from '../registry.js';
import { stripPrivateTags } from '../../security/private-tags.js';
import { payloadHash, payloadByteLength } from '../../security/payload-hash.js';
import { insertEvent, IdempotencyConflictError as RepoIdempotencyConflictError } from '../../db/repositories/events.js';
import { createJob } from '../../db/repositories/jobs.js';
import { isProjectScope, getTeamId, getProjectId } from '../../auth/scope.js';
import { and, eq } from 'drizzle-orm';
import * as dbSchema from '../../db/schema.js';

// ── Tool input schema (what the MCP client sends) ───────────────────────────

const memoryWriteInputSchema = z.object({
  /** The text content to store (maps to mcpWritePayload.text). */
  content: z.string().min(1).describe(
    'The text content to store as a memory. This is the main body of the observation.',
  ),
  /** Optional title for the memory. */
  title: z.string().optional().describe(
    'An optional title or summary for this memory.',
  ),
  /** Optional suggested concept type. */
  suggestedType: z.enum([
    'decision', 'gotcha', 'convention', 'runbook', 'service', 'concept',
  ] as const).optional().describe(
    'Optional suggested concept type for compilation.',
  ),
  /** Optional tags. */
  tags: z.array(z.string()).optional().describe(
    'Optional tags for categorisation.',
  ),
  /**
   * When the key is allProjects scoped, the agent MUST supply the target
   * project id. Project-scoped keys ignore this field — the project is
   * derived from the key itself.
   */
  projectId: z.string().optional().describe(
    'Target project id. Required only when using a team-wide (allProjects) API key.',
  ),
});

// ── Channel / connector constants for the MCP channel ───────────────────────

const CHANNEL = 'mcp' as const;
const KIND = 'mcp_write' as const;
const CONNECTOR_KIND = 'mcp' as const;

// ── Handler ─────────────────────────────────────────────────────────────────

async function handleMemoryWrite(
  rawArgs: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const { db, queue, auth } = ctx;

  // ── Step 1: Validate input ────────────────────────────────────────────
  const parsed = memoryWriteInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return {
      content: [{ type: 'text', text: `Validation error: ${details}` }],
      isError: true,
    };
  }
  const input = parsed.data;

  // ── Step 2: Derive scope from the API key ──────────────────────────────
  const teamId = getTeamId(auth.scope);
  let projectId: string;

  if (isProjectScope(auth.scope)) {
    projectId = getProjectId(auth.scope);
  } else {
    // allProjects key — the agent must supply a project id.
    if (!input.projectId) {
      return {
        content: [{
          type: 'text',
          text: 'projectId is required when using a team-wide (allProjects) API key',
        }],
        isError: true,
      };
    }
    // Verify the project exists and belongs to this team (anti-enumeration).
    const projectRows = await db
      .select({ id: dbSchema.projects.id })
      .from(dbSchema.projects)
      .where(
        and(
          eq(dbSchema.projects.teamId, teamId),
          eq(dbSchema.projects.id, input.projectId),
        ),
      )
      .limit(1);
    if (projectRows.length === 0) {
      return {
        content: [{ type: 'text', text: `Project ${input.projectId} not found` }],
        isError: true,
      };
    }
    projectId = input.projectId;
  }

  // ── Step 3: Build the mcp_write payload ───────────────────────────────
  const rawPayload: Record<string, unknown> = {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    text: input.content,
  };
  if (input.title !== undefined) rawPayload.title = input.title;
  if (input.suggestedType !== undefined) rawPayload.suggestedType = input.suggestedType;
  if (input.tags !== undefined) rawPayload.tags = input.tags;

  // ── Step 4: Strip <private> tags BEFORE hashing/persistence ───────────
  const redactedPayload = stripPrivateTags(rawPayload) as Record<string, unknown>;

  // ── Step 5: Compute payload hash & byte length on REDACTED content ────
  const hash = payloadHash(redactedPayload);
  const byteLen = payloadByteLength(redactedPayload);

  // ── Step 6: Generate server-side deliveryId (UUID) ────────────────────
  const deliveryId = randomUUID();

  // ── Step 7: Build externalId — human-meaningful reference ─────────────
  // SECURITY: Use the REDACTED title so that <private> tags in the title
  // are stripped from externalId too (AGENTS.md §5.3).
  const redactedTitle = typeof redactedPayload.title === 'string' && redactedPayload.title.length > 0
    ? redactedPayload.title
    : undefined;
  const externalId = redactedTitle
    ? `mcp:${redactedTitle.slice(0, 100)}`
    : `mcp:memory_write:${Date.now()}`;

  // ── Step 8: Idempotent event insert ───────────────────────────────────
  const now = new Date();

  let eventId: string;
  let status: 'inserted' | 'duplicate';
  try {
    const result = await insertEvent(db, {
      teamId,
      projectId,
      channel: CHANNEL,
      kind: KIND,
      connectorKind: CONNECTOR_KIND,
      deliveryId,
      itemKey: 'root',
      externalId,
      url: null,
      actor: null,
      actorProvenance: 'unknown',
      actorPrincipalId: null,
      occurredAt: now,
      occurredAtProvenance: 'server',
      ingestedByCredentialId: auth.credentialId,
      ingestedByPrincipalId: auth.principal?.id ?? null,
      payload: redactedPayload,
      payloadHash: hash,
      payloadBytes: byteLen,
      payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
      envelopeVersion: EVENT_ENVELOPE_VERSION,
    });
    eventId = result.eventId;
    status = result.status;
  } catch (err) {
    if (err instanceof RepoIdempotencyConflictError) {
      return {
        content: [{
          type: 'text',
          text: `Idempotency conflict: ${err.message}`,
        }],
        isError: true,
      };
    }
    throw err;
  }

  // ── Step 9: Create a compile job (always compile=true for MCP writes) ─
  let jobId: string | null = null;
  if (status === 'inserted') {
    const compileJobIdempotencyKey = `compile:${eventId}`;
    try {
      const jobResult = await createJob(db, {
        teamId,
        projectId,
        kind: 'ingest_event',
        initiatedByKind: 'credential',
        initiatedByCredentialId: auth.credentialId,
        initiatedByPrincipalId: auth.principal?.id ?? null,
        idempotencyKey: compileJobIdempotencyKey,
        idempotencyRequestHash: hash,
        eventCount: 1,
      });
      jobId = jobResult.job.id;

      // Enqueue in pg-boss when queue is available and job was newly created.
      if (queue && jobResult.created) {
        try {
          await queue.send({ jobId, eventId });
        } catch (err) {
          console.error(
            JSON.stringify({
              event: 'mcp_memory_write_enqueue_failed',
              jobId,
              eventId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    } catch (err) {
      // Job creation failure — event is already persisted. Log and report
      // partial success (event stored but compilation not scheduled).
      console.error(
        JSON.stringify({
          event: 'mcp_memory_write_job_failed',
          eventId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return {
        content: [{
          type: 'text',
          text: `Memory stored as event ${eventId}, but compile job creation failed.`,
        }],
        isError: true,
      };
    }
  }

  // ── Step 10: Return success ───────────────────────────────────────────
  const jobSuffix = jobId ? ` (compile job: ${jobId})` : '';
  return {
    content: [{
      type: 'text',
      text: `Memory stored successfully. Event: ${eventId}${jobSuffix}`,
    }],
  };
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Register the `memory_write` tool in the given registry.
 *
 * The tool's inputSchema is a JSON Schema object that describes the
 * arguments the MCP client must supply when calling `tools/call` with
 * this tool name.
 */
export function registerMemoryWriteTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'memory_write',
      description:
        'Store an observation, decision, or "dead-end / no-diff" finding as a memory in the team knowledge base. ' +
        'The content is validated, redacted (private tags stripped), persisted, and queued for compilation into ' +
        'structured concept pages. Use this for facts worth keeping — not transient conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              'The text content to store as a memory. This is the main body of the observation.',
          },
          title: {
            type: 'string',
            description: 'An optional title or summary for this memory.',
          },
          suggestedType: {
            type: 'string',
            enum: ['decision', 'gotcha', 'convention', 'runbook', 'service', 'concept'],
            description: 'Optional suggested concept type for compilation.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for categorisation.',
          },
          projectId: {
            type: 'string',
            description:
              'Target project id. Required only when using a team-wide (allProjects) API key.',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    handleMemoryWrite,
    ['events:write'],
  );
}
