/**
 * MCP Tool Registry (DUA-206 M1-MCP-01 + DUA-208).
 *
 * Maintains the list of registered MCP tools and their handler functions.
 * Each tool registered via `register()` exposes both its MCP metadata
 * (name, description, inputSchema) and a handler that implements the
 * tool's behaviour.
 *
 * This module owns the tool list; the MCP transport layer reads it
 * via `listTools()` for the `tools/list` JSON-RPC method, and delegates
 * to tool handlers via `getHandler()` for `tools/call`.
 */
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
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

/** Context available to every tool handler during execution. */
export interface ToolContext {
  db: AppDb;
  auth: AuthContext;
  requestId: string;
}

/** MCP CallToolResult content item. */
export interface ToolContentItem {
  type: 'text';
  text: string;
}

/** Tool handler return value — maps to MCP CallToolResult. */
export interface ToolResult {
  content: ToolContentItem[];
  isError?: boolean;
}

/** Signature of a tool handler function. */
export type ToolHandler = (
  args: unknown,
  ctx: ToolContext,
) => Promise<ToolResult>;

// ── Registry ────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: McpTool[] = [];
  private handlers = new Map<string, ToolHandler>();

  /** Register a tool with its metadata and handler. Idempotent — replacing
   *  a tool with the same name updates it (last-write-wins). */
  register(tool: McpTool, handler: ToolHandler): void {
    const existing = this.tools.findIndex((t) => t.name === tool.name);
    if (existing >= 0) {
      this.tools[existing] = tool;
    } else {
      this.tools.push(tool);
    }
    this.handlers.set(tool.name, handler);
  }

  /** Return the handler for a tool, or undefined if not registered. */
  getHandler(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** Return a snapshot of all registered tools (for tools/list). */
  listTools(): McpTool[] {
    return [...this.tools];
  }
}
