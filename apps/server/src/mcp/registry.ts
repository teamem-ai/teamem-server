/**
 * MCP Tool Registry — empty scaffolding (DUA-206 M1-MCP-01).
 *
 * Maintains the list of registered MCP tools. Future tasks
 * (search, get_page, timeline, memory_write) will call `register()`
 * to populate the registry.
 *
 * This module owns the tool list; the MCP transport layer reads it
 * via `listTools()` for the `tools/list` JSON-RPC method.
 */
import { z } from 'zod';

// ── Tool definition schema ──────────────────────────────────────────────────
// Matches the MCP Tool type: name, optional description, and JSON Schema
// for the tool's input parameters.

export const mcpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export type McpTool = z.infer<typeof mcpToolSchema>;

// ── Registry ────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: McpTool[] = [];

  /** Register a tool. Idempotent — replacing a tool with the same name
   *  updates it (last-write-wins). */
  register(tool: McpTool): void {
    const existing = this.tools.findIndex((t) => t.name === tool.name);
    if (existing >= 0) {
      this.tools[existing] = tool;
    } else {
      this.tools.push(tool);
    }
  }

  /** Return a snapshot of all registered tools (for tools/list). */
  listTools(): McpTool[] {
    return [...this.tools];
  }
}
