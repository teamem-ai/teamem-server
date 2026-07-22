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
import type { AuthContext } from '../db/repositories/api-keys.js';
import { requireAuth, getAuth } from '../http/auth.js';
import { REQUEST_ID_KEY } from '../http/errors.js';
import { ToolRegistry } from './registry.js';

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
/** Invalid method parameter(s). Use for validation errors, bad cursors, etc. */
export const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

// ── McpToolError base class ────────────────────────────────────────────────

/**
 * Base error for MCP tool handlers that carry a JSON-RPC error code.
 *
 * Tool implementations should prefer returning ToolResult with isError: true
 * for validation / input errors.  This class exists as a safety net:
 * exceptions thrown by handlers are caught and mapped via jsonRpcCode.
 * The default code is JSONRPC_INTERNAL_ERROR (-32603); subclasses may
 * override with JSONRPC_INVALID_PARAMS (-32602) or other codes.
 */
export class McpToolError extends Error {
  readonly jsonRpcCode: number;

  constructor(message: string, jsonRpcCode: number = JSONRPC_INTERNAL_ERROR) {
    super(message);
    this.name = 'McpToolError';
    this.jsonRpcCode = jsonRpcCode;
  }
}

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

// ── tools/call params schema ────────────────────────────────────────────────

const toolsCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

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
 * Returns the current tool list from the registry.
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

/**
 * Handle the `tools/call` request.
 *
 * Looks up the tool handler by name, validates params, derives the
 * ToolContext from the AuthContext, and delegates to the handler.
 *
 * Tool errors (not found, invalid args, etc.) are returned as MCP
 * CallToolResult with `isError: true`, not as JSON-RPC errors.  This
 * lets the LLM see structured error information.
 *
 * Handlers that throw McpToolError subclasses are caught here and
 * mapped to JSON-RPC errors with the appropriate error code
 * (e.g. INVALID_PARAMS for validation failures, INTERNAL_ERROR for
 * genuine infrastructure errors).  Handlers should prefer returning
 * isError content rather than throwing, but this catch provides a
 * safety net and ensures the LLM never sees a bare INTERNAL_ERROR
 * for an invalid-params problem.
 */
async function handleToolsCall(
  req: JsonRpcRequest,
  id: string | number,
  registry: ToolRegistry,
  db: AppDb,
  auth: AuthContext,
  requestId: string,
): Promise<JsonRpcSuccess | JsonRpcError> {
  // Validate params shape
  const parsed = toolsCallParamsSchema.safeParse(req.params ?? {});
  if (!parsed.success) {
    return jsonRpcSuccess(id, {
      content: [{ type: 'text', text: `Invalid params: ${parsed.error.message}` }],
      isError: true,
    });
  }

  const { name, arguments: args } = parsed.data;

  // Look up handler
  const handler = registry.getHandler(name);
  if (!handler) {
    return jsonRpcSuccess(id, {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    });
  }

  // Build tool context and delegate
  const ctx = { db, auth, requestId };
  try {
    const result = await handler(args ?? {}, ctx);
    return jsonRpcSuccess(id, result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Tool execution failed';

    // Determine the JSON-RPC error code from the error type:
    // - McpToolError subclasses carry their own code (e.g. INVALID_PARAMS)
    // - All other errors default to INTERNAL_ERROR
    const code =
      err instanceof McpToolError ? err.jsonRpcCode : JSONRPC_INTERNAL_ERROR;

    console.error(
      JSON.stringify({
        event: 'mcp_tool_error',
        requestId,
        tool: name,
        errorClass: (err as Error).constructor?.name ?? 'unknown',
        jsonRpcCode: code,
        message,
      }),
    );
    return jsonRpcError(id, code, message);
  }
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface McpDeps {
  db: AppDb;
  registry: ToolRegistry;
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
    const auth = getAuth(c);

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
            await handleToolsCall(
              req,
              rpcId,
              deps.registry,
              deps.db,
              auth,
              requestId,
            ),
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
      const code =
        err instanceof McpToolError
          ? err.jsonRpcCode
          : JSONRPC_INTERNAL_ERROR;
      console.error(
        JSON.stringify({
          event: 'mcp_method_error',
          requestId,
          method: req.method,
          errorClass: (err as Error).constructor?.name ?? 'unknown',
          jsonRpcCode: code,
        }),
      );
      return c.json(
        jsonRpcError(req.id, code, 'Internal error'),
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
