/**
 * MCP Streamable HTTP Transport — JSON-RPC 2.0 over HTTP (DUA-206 M1-MCP-01).
 *
 * Provides a mountable Hono route builder that:
 * - Accepts POST /mcp with JSON-RPC 2.0 bodies
 * - Authenticates via Bearer token (same requireAuth middleware as REST)
 * - Derives a ScopeContext from the API key for downstream tool handlers
 * - Handles the MCP initialization handshake (initialize → capabilities)
 * - Exposes tools/list backed by a ToolRegistry
 * - Returns JSON-RPC errors for parse failures, unknown methods, etc.
 *
 * Auth failures are handled by the global error handler (401 with standard
 * error envelope), mirroring the REST API behaviour.  JSON-RPC-level errors
 * (e.g. invalid JSON, unknown method) return HTTP 200 with a JSON-RPC error
 * body per the MCP specification.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
import { requireAuth, getAuth } from '../http/auth.js';
import { REQUEST_ID_KEY } from '../http/errors.js';
import { ToolRegistry } from './registry.js';
import type { AuthContext } from '../db/repositories/api-keys.js';

// ── MCP constants ───────────────────────────────────────────────────────────

/** MCP protocol version implemented by this server. */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Server identity reported in the initialize response. */
const SERVER_INFO = {
  name: 'teamem',
  version: '0.1.0',
} as const;

// ── JSON-RPC 2.0 types & schemas ────────────────────────────────────────────

const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ── JSON-RPC error codes (standard reserved range) ──────────────────────────

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonRpcSuccess(id: string | number, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0' as const, id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

// ── Method handlers ─────────────────────────────────────────────────────────

/**
 * Handle the `initialize` request.
 *
 * Returns server capabilities: tools with listChanged=false (tool list
 * is static in this scaffolding; future dynamic registration may set
 * listChanged=true).
 */
function handleInitialize(
  _req: JsonRpcRequest,
  id: string | number,
): JsonRpcSuccess {
  return jsonRpcSuccess(id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: SERVER_INFO,
  });
}

/**
 * Handle the `tools/list` request.
 *
 * Returns the current tool list from the registry.  In this scaffolding
 * the registry is empty; future tasks will register concrete tools
 * (search, get_page, timeline, memory_write).
 */
function handleToolsList(
  _req: JsonRpcRequest,
  id: string | number,
  registry: ToolRegistry,
): JsonRpcSuccess {
  return jsonRpcSuccess(id, {
    tools: registry.listTools(),
  });
}

// ── tools/call params schema ────────────────────────────────────────────────

const toolsCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Handle the `tools/call` request.
 *
 * Looks up the tool handler by name, parses the arguments, and executes
 * the handler. Returns MCP-formatted content on success, or a JSON-RPC
 * error on failure.
 */
async function handleToolsCall(
  req: JsonRpcRequest,
  id: string | number,
  deps: McpDeps,
  c: Context,
): Promise<JsonRpcSuccess | JsonRpcError> {
  // 1. Parse params
  const paramsParsed = toolsCallParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return jsonRpcError(id, JSONRPC_INVALID_REQUEST, 'Invalid params: name is required');
  }

  const { name, arguments: toolArgs } = paramsParsed.data;

  // 2. Look up handler
  const handler = deps.toolHandlers?.get(name);
  if (!handler) {
    return jsonRpcError(id, JSONRPC_METHOD_NOT_FOUND, `Tool not found: ${name}`);
  }

  // 3. Build context
  const auth = getAuth(c);
  const requestId = c.get(REQUEST_ID_KEY) as string;

  // 4. Execute handler
  try {
    const result = await handler(toolArgs ?? {}, { db: deps.db, auth, requestId });
    // Return MCP-formatted content: { content: [{ type: 'text', text: ... }] }
    return jsonRpcSuccess(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Tool execution failed';
    console.error(
      JSON.stringify({
        event: 'mcp_tool_error',
        requestId,
        tool: name,
        errorClass: (err as Error).constructor?.name ?? 'unknown',
        message,
      }),
    );
    return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, message);
  }
}

// ── Tool handler types ──────────────────────────────────────────────────────

/** Context passed to every tool handler. */
export interface ToolHandlerContext {
  db: AppDb;
  auth: AuthContext;
  requestId: string;
}

/** A tool handler: receives arguments and context, returns the MCP result. */
export type ToolHandler = (
  args: unknown,
  ctx: ToolHandlerContext,
) => Promise<unknown>;

// ── Dependencies ────────────────────────────────────────────────────────────

export interface McpDeps {
  db: AppDb;
  registry: ToolRegistry;
  /** Map of tool name → handler function. */
  toolHandlers?: Map<string, ToolHandler>;
}

// ── Route builder ───────────────────────────────────────────────────────────

/**
 * Build the MCP routes as a mountable Hono instance.
 *
 * Usage in app.ts:
 *   app.route('/', buildMcpRoutes({ db, registry }));
 *
 * The returned Hono instance isolates MCP middleware so the global
 * /mcp prefix does not leak into other route groups.
 */
export function buildMcpRoutes(deps: McpDeps): Hono {
  const routes = new Hono();

  // Auth middleware — same Bearer token auth as the REST API.
  // Failures throw UnauthorizedError → caught by globalErrorHandler → 401.
  routes.use('/mcp', requireAuth(deps.db));

  // Main MCP handler for POST requests.
  routes.post('/mcp', async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;

    // ── Step 1: Parse the JSON-RPC body ──────────────────────────────
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      // JSON parse failure → JSON-RPC parse error (HTTP 200)
      return c.json(
        jsonRpcError(null, JSONRPC_PARSE_ERROR, 'Parse error'),
        200,
      );
    }

    const parsed = jsonRpcRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        jsonRpcError(
          (rawBody as Record<string, unknown>)?.id != null
            ? ((rawBody as Record<string, unknown>).id as string | number)
            : null,
          JSONRPC_INVALID_REQUEST,
          'Invalid Request',
        ),
        200,
      );
    }

    const req = parsed.data;

    // ── Step 2: Handle notifications (no id) ────────────────────────
    if (req.id === undefined) {
      // Per JSON-RPC 2.0, notifications (no `id`) receive no response.
      return c.body(null, 202);
    }

    // ── Step 3: Derive ScopeContext and dispatch to method handler ───
    // AuthContext is available via getAuth(c) — scope.teamId / scope
    // (tagged union) are ready for downstream tools to use.
    // The scope derivation from the API key is complete at this point.
    void getAuth(c);

    // At this point req.id is guaranteed non-undefined (notification path
    // returned early above). Narrow for the method handlers.
    const rpcId = req.id;

    try {
      switch (req.method) {
        case 'initialize':
          return c.json(handleInitialize(req, rpcId), 200);
        case 'tools/list':
          return c.json(handleToolsList(req, rpcId, deps.registry), 200);
        case 'tools/call':
          return c.json(
            await handleToolsCall(req, rpcId, deps, c),
            200,
          );
        default:
          return c.json(
            jsonRpcError(
              rpcId,
              JSONRPC_METHOD_NOT_FOUND,
              `Method not found: ${req.method}`,
            ),
            200,
          );
      }
    } catch (err) {
      // Internal errors during method dispatch — log safely and return
      // a generic JSON-RPC internal error.
      console.error(
        JSON.stringify({
          event: 'mcp_method_error',
          requestId,
          method: req.method,
          errorClass: (err as Error).constructor?.name ?? 'unknown',
        }),
      );
      return c.json(
        jsonRpcError(req.id, JSONRPC_INTERNAL_ERROR, 'Internal error'),
        200,
      );
    }
  });

  // Reject non-POST requests to /mcp with method-not-allowed.
  routes.on(['GET', 'PUT', 'DELETE', 'PATCH'], '/mcp', (c: Context) => {
    c.header('Allow', 'POST');
    // Return a JSON-RPC error since the client sent a request to an MCP
    // endpoint but used the wrong HTTP method.
    return c.json(
      jsonRpcError(null, JSONRPC_INVALID_REQUEST, 'MCP endpoint only accepts POST'),
      405,
    );
  });

  return routes;
}
