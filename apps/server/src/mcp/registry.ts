/**
 * MCP Tool Registry (DUA-206 M1-MCP-01, extended DUA-210).
 *
 * Maintains the list of registered MCP tools and their handlers.
 * The MCP transport layer reads tool definitions via `listTools()` for
 * `tools/list` and dispatches `tools/call` via `execute()`.
 *
 * This module owns the tool list; the MCP transport layer reads it
 * via `listTools()` for the `tools/list` JSON-RPC method.
 */
import { z } from 'zod';
import type { ApiScope } from '@teamem/schema';
import type { AppDb } from '../db/client.js';
import type { CompileQueue } from '../queue/boss.js';
import type { AuthContext } from '../db/repositories/api-keys.js';

// ── Tool definition schema ──────────────────────────────────────────────────
// Matches the MCP Tool type: name, optional description, and JSON Schema
// for the tool's input parameters.

export const mcpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export type McpTool = z.infer<typeof mcpToolSchema>;

// ── Tool execution types ────────────────────────────────────────────────────

/**
 * Context passed to every tool handler at call time. Carries the
 * authenticated scope, database handle, and optional compile queue
 * so tools can persist events through the standard ingestion pipeline.
 */
export interface ToolExecutionContext {
  db: AppDb;
  queue?: CompileQueue;
  auth: AuthContext;
}

/**
 * An MCP tool call result — a list of content items returned to the
 * MCP client. Matches the MCP spec: each item has a `type` and
 * type-specific fields.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  /** When true, the MCP client should treat this as an error. */
  isError?: boolean;
}

/**
 * A tool handler receives validated arguments and an execution context,
 * and returns a structured result for the MCP client.
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<ToolResult>;

// ── Internal entry ──────────────────────────────────────────────────────────

interface RegisteredTool {
  definition: McpTool;
  handler: ToolHandler;
  /**
   * API key scopes required to invoke this tool.
   * When non-empty, every scope must be present in the key's scopes list.
   * Read tools (search, get_page, timeline) require ['read']; write tools
   * (memory_write) require ['events:write']; tools that read payloads
   * require ['read', 'read:payload'].
   */
  requiredScopes: readonly ApiScope[];
}

// ── Registry ────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * Register a tool with its handler and required API key scopes.
   * Idempotent — replacing a tool with the same name updates definition,
   * handler, and required scopes (last-write-wins).
   *
   * @param tool           Tool definition for tools/list.
   * @param handler        Async handler invoked on tools/call.
   * @param requiredScopes API key scopes required to call this tool.
   *                        Defaults to empty (no scope requirement).
   */
  register(
    tool: McpTool,
    handler: ToolHandler,
    requiredScopes: readonly ApiScope[] = [],
  ): void {
    this.tools.set(tool.name, { definition: tool, handler, requiredScopes });
  }

  /** Return a snapshot of all registered tool definitions (for tools/list). */
  listTools(): McpTool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Execute a tool by name with the given arguments and context.
   *
   * Before invoking the handler, verifies that the authenticated API key
   * possesses every scope required by the tool.  Missing scopes produce
   * a structured error result (isError: true) — no exception is thrown.
   *
   * @throws Error when the tool name is not registered.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const registered = this.tools.get(name);
    if (!registered) {
      throw new Error(`Tool not found: ${name}`);
    }

    // ── Per-tool scope enforcement (AGENTS.md §8) ──────────────────────
    if (registered.requiredScopes.length > 0) {
      const missing = registered.requiredScopes.filter(
        (s) => !ctx.auth.scopes.includes(s),
      );
      if (missing.length > 0) {
        return {
          content: [{
            type: 'text',
            text: `This tool requires the following scope(s): ${missing.join(', ')}. ` +
              `Your API key does not have them.`,
          }],
          isError: true,
        };
      }
    }

    return registered.handler(args, ctx);
  }
}
