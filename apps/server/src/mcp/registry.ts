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
}

// ── Registry ────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * Register a tool with its handler. Idempotent — replacing a tool
   * with the same name updates both definition and handler (last-write-wins).
   */
  register(tool: McpTool, handler: ToolHandler): void {
    this.tools.set(tool.name, { definition: tool, handler });
  }

  /** Return a snapshot of all registered tool definitions (for tools/list). */
  listTools(): McpTool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Execute a tool by name with the given arguments and context.
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
    return registered.handler(args, ctx);
  }
}
