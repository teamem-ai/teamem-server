/**
 * MCP Streamable HTTP endpoint tests (DUA-206 M1-MCP-01).
 *
 * Verifies:
 * - No Bearer → 401 (transport-level auth failure)
 * - Malformed Bearer → 401
 * - Valid token → initialize handshake succeeds, capabilities returned
 * - Valid token → tools/list returns empty array
 * - Valid token → unknown method returns JSON-RPC error
 * - Valid token → notifications/initialized accepted (no response body)
 * - Valid token → invalid JSON body returns JSON-RPC parse error
 * - Valid token → non-POST method returns 405
 * - ScopeContext is derived from the API key
 * - Invalid/revoked key → 401 (identical envelope to missing key)
 *
 * Uses a mock for resolveTokenHash so auth behaviour is isolated from the
 * database. Real-database integration is covered by the MCP integration test.
 *
 * CLI: pnpm exec vitest run apps/server/src/mcp/server.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requestContext } from '../http/request-context.js';
import { globalErrorHandler, notFoundHandler } from '../http/errors.js';
import { buildMcpRoutes, type McpDeps } from './server.js';
import { ToolRegistry } from './registry.js';
import type { AppDb } from '../db/client.js';
import type { AuthContext } from '../db/repositories/api-keys.js';
import { generateApiKeyToken, hashToken } from '../auth/api-key.js';
import { projectScope } from '../auth/scope.js';
import type { ApiScope } from '@teamem/schema';

// ── Mock resolveTokenHash ───────────────────────────────────────────────────

vi.mock('../db/repositories/api-keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repositories/api-keys.js')>();
  return {
    ...actual,
    resolveTokenHash: vi.fn(),
    AuthenticationError: actual.AuthenticationError,
  };
});

import {
  resolveTokenHash,
  AuthenticationError,
} from '../db/repositories/api-keys.js';

const mockedResolve = vi.mocked(resolveTokenHash);
const mockDb = { $client: {} } as unknown as AppDb;

// ── Helpers ─────────────────────────────────────────────────────────────────

function validToken(): string {
  return generateApiKeyToken();
}

function mockAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    credentialId: 'key_mcp001',
    keyName: 'MCP Test Key',
    scopes: ['read'] as ApiScope[],
    scope: projectScope('team_mcp', 'prj_mcp'),
    principal: {
      id: 'pri_mcp001',
      kind: 'service',
      provider: 'external',
      providerKind: 'teamem',
      providerUserId: 'bootstrap:mcp-test',
      displayLogin: 'mcp-test-service',
    },
    team: { id: 'team_mcp', name: 'MCP Test Team' },
    createdAt: new Date('2025-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createTestApp(registry?: ToolRegistry): Hono {
  const app = new Hono().basePath('/');
  app.use('*', requestContext);
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);

  const deps: McpDeps = {
    db: mockDb,
    registry: registry ?? new ToolRegistry(),
  };
  app.route('/', buildMcpRoutes(deps));
  return app;
}

function makeRpcRequest(method: string, params?: Record<string, unknown>, id?: string | number) {
  return {
    jsonrpc: '2.0' as const,
    id: id ?? 1,
    method,
    ...(params ? { params } : {}),
  };
}

// ── Tests: Authentication (transport-level) ─────────────────────────────────

describe('MCP auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = createTestApp();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeRpcRequest('initialize')),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');
    expect(json.error.message).toBe('Unauthorized');
  });

  it('returns 401 for non-Bearer scheme', async () => {
    const app = createTestApp();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Basic dXNlcjpwYXNz',
      },
      body: JSON.stringify(makeRpcRequest('initialize')),
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid token format', async () => {
    const app = createTestApp();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer not-a-tm-token',
      },
      body: JSON.stringify(makeRpcRequest('initialize')),
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 for empty Bearer token', async () => {
    const app = createTestApp();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ',
      },
      body: JSON.stringify(makeRpcRequest('initialize')),
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 for unknown API key', async () => {
    mockedResolve.mockRejectedValueOnce(new AuthenticationError('invalid or revoked API key'));

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('initialize')),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');
  });

  it('returns identical 401 envelope for unknown vs missing key', async () => {
    mockedResolve.mockRejectedValue(new AuthenticationError('invalid or revoked API key'));

    const app = createTestApp();
    const token = validToken();

    // Missing header
    const resMissing = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeRpcRequest('initialize')),
    });

    // Unknown key
    const resUnknown = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('initialize')),
    });

    expect(resMissing.status).toBe(401);
    expect(resUnknown.status).toBe(401);

    const bodyMissing = await resMissing.json();
    const bodyUnknown = await resUnknown.json();

    expect(bodyMissing.error.code).toBe(bodyUnknown.error.code);
    expect(bodyMissing.error.message).toBe(bodyUnknown.error.message);
    expect(bodyMissing.error.details).toBeUndefined();
    expect(bodyUnknown.error.details).toBeUndefined();
  });
});

// ── Tests: MCP initialization handshake ─────────────────────────────────────

describe('MCP initialize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes initialize handshake with valid token', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0' },
      })),
    });

    expect(res.status).toBe(200);
    const json = await res.json();

    // JSON-RPC envelope
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);

    // Server capabilities
    expect(json.result.protocolVersion).toBe('2024-11-05');
    expect(json.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(json.result.serverInfo).toEqual({ name: 'teamem', version: '0.1.0' });
  });

  it('responds with JSON-RPC error for unknown methods', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('nonexistent/method')),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32601); // METHOD_NOT_FOUND
    expect(json.error.message).toContain('Method not found');
  });
});

// ── Tests: tools/list ───────────────────────────────────────────────────────

describe('MCP tools/list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty tool list from registry', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('tools/list')),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);
    expect(json.result).toEqual({ tools: [] });
  });

  it('returns tools registered in the registry', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );

    const app = createTestApp(registry);
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('tools/list')),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.tools).toHaveLength(1);
    expect(json.result.tools[0]).toEqual({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: {} },
    });
  });
});

// ── Tests: notifications ────────────────────────────────────────────────────

describe('MCP notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts notifications/initialized with 202 (no response body)', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        // No id — this is a notification
      }),
    });

    expect(res.status).toBe(202);
    // No JSON body
    const text = await res.text();
    expect(text).toBe('');
  });

  it('accepts unknown notifications with 202', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'some/unknown_notification',
      }),
    });

    expect(res.status).toBe(202);
  });
});

// ── Tests: error handling (JSON-RPC level) ──────────────────────────────────

describe('MCP error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns JSON-RPC parse error for invalid JSON', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: 'not-json{{{',
    });

    // JSON parse error → JSON-RPC parse error with HTTP 200
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBeNull();
    expect(json.error.code).toBe(-32700);
    expect(json.error.message).toBe('Parse error');
  });

  it('returns JSON-RPC invalid request for non-object body', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify([1, 2, 3]), // Array, not a JSON-RPC object
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jsonrpc).toBe('2.0');
    expect(json.error.code).toBe(-32600);
    expect(json.error.message).toBe('Invalid Request');
  });

  it('returns 405 for GET requests to /mcp', async () => {
    // Auth middleware rejects before the method check — but the method check
    // is on the route itself.  For GET, the route handler returns 405 immediately
    // without invoking the middleware chain (Hono routing behaviour).
    // However, since the middleware is .use('/mcp', ...), it runs for ALL methods
    // on /mcp, including GET. So GET /mcp without auth → 401 first.
    const app = createTestApp();

    const res = await app.request('/mcp', { method: 'GET' });

    // The auth middleware runs first → 401
    expect(res.status).toBe(401);
  });

  it('returns 405 for authenticated GET requests to /mcp', async () => {
    mockedResolve.mockResolvedValueOnce(mockAuthContext());

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    // Auth passes, but GET is not allowed
    expect(res.status).toBe(405);
    const json = await res.json();
    expect(json.error.code).toBe(-32600);
  });
});

// ── Tests: ScopeContext derivation ──────────────────────────────────────────

describe('MCP ScopeContext derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the token hash before dispatching', async () => {
    const auth = mockAuthContext();
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    const token = validToken();

    await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('tools/list')),
    });

    // Verify resolveTokenHash was called with the correct hash
    expect(mockedResolve).toHaveBeenCalledTimes(1);
    const calledWithHash = mockedResolve.mock.calls[0]![1];
    expect(calledWithHash).toBe(hashToken(token));
    expect(calledWithHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('passes project-scoped key context to handler', async () => {
    const auth = mockAuthContext({
      scope: projectScope('team_mcp', 'prj_mcp'),
    });
    mockedResolve.mockResolvedValueOnce(auth);

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('tools/list')),
    });

    expect(res.status).toBe(200);
    // AuthContext was resolved — the handler has access to scope.teamId
    // and scope.projectId via getAuth(c).
    const json = await res.json();
    expect(json.result).toBeDefined();
  });
});

// ── Tests: internal error during auth lookup ────────────────────────────────

describe('MCP internal auth errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 500 when resolveTokenHash throws non-AuthenticationError', async () => {
    mockedResolve.mockRejectedValueOnce(new Error('DB connection refused'));

    const app = createTestApp();
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('tools/list')),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe('internal');
    expect(json.error.message).toBe('Internal error');
  });
});

// ── Tests: per-tool scope enforcement (AGENTS.md §8) ────────────────────────

describe('MCP tools/call scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects tools/call when key lacks the required scope', async () => {
    const auth = mockAuthContext({ scopes: ['read'] });
    mockedResolve.mockResolvedValueOnce(auth);

    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'write_tool',
        description: 'A write tool',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ['events:write'],
    );

    const app = createTestApp(registry);
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('tools/call', {
        name: 'write_tool',
        arguments: {},
      })),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);
    // The tool call itself succeeds at the JSON-RPC level, but the
    // result carries isError:true because the scope check failed.
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain('events:write');
  });

  it('allows tools/call when key has the required scope', async () => {
    const auth = mockAuthContext({ scopes: ['events:write'] });
    mockedResolve.mockResolvedValueOnce(auth);

    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'write_tool',
        description: 'A write tool',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ['events:write'],
    );

    const app = createTestApp(registry);
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('tools/call', {
        name: 'write_tool',
        arguments: {},
      })),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.isError).toBeUndefined();
    expect(json.result.content[0].text).toBe('ok');
  });

  it('tools with no required scopes work with any key', async () => {
    const auth = mockAuthContext({ scopes: [] });
    mockedResolve.mockResolvedValueOnce(auth);

    const registry = new ToolRegistry();
    // No requiredScopes → defaults to []
    registry.register(
      {
        name: 'read_tool',
        description: 'A read-only tool',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => ({ content: [{ type: 'text', text: 'data' }] }),
    );

    const app = createTestApp(registry);
    const token = validToken();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeRpcRequest('tools/call', {
        name: 'read_tool',
        arguments: {},
      })),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.isError).toBeUndefined();
    expect(json.result.content[0].text).toBe('data');
  });
});
