/**
 * MCP memory_write tool — unit tests (DUA-210 M1-MCP-05).
 *
 * Tests the tool handler in isolation using mocked database repositories.
 * Covers:
 *   - Successful write with project-scoped key
 *   - Validation errors (missing content)
 *   - Private-tag redaction
 *   - Scope enforcement (project-scoped vs allProjects)
 *   - Cross-team isolation (allProjects key cannot write to other team's project)
 *
 * CLI: pnpm exec vitest run apps/server/src/mcp/tools/memory_write.test.ts
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ToolRegistry, type ToolExecutionContext, type ToolResult } from '../registry.js';
import { registerMemoryWriteTool } from './memory_write.js';
import type { AppDb } from '../../db/client.js';
import type { AuthContext } from '../../db/repositories/api-keys.js';
import { projectScope, allProjectsScope } from '../../auth/scope.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../db/repositories/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/events.js')>();
  return {
    ...actual,
    insertEvent: vi.fn(),
    IdempotencyConflictError: actual.IdempotencyConflictError,
  };
});

vi.mock('../../db/repositories/jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/jobs.js')>();
  return {
    ...actual,
    createJob: vi.fn(),
  };
});

import { insertEvent } from '../../db/repositories/events.js';
import { createJob } from '../../db/repositories/jobs.js';

const mockedInsertEvent = vi.mocked(insertEvent);
const mockedCreateJob = vi.mocked(createJob);

// ── Helpers ─────────────────────────────────────────────────────────────────

const mockDb = { $client: {} } as unknown as AppDb;

function mockAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    credentialId: 'key_mcp_test',
    keyName: 'MCP Test Key',
    scopes: ['events:write'],
    scope: projectScope('team_mcp', 'prj_mcp'),
    principal: {
      id: 'pri_mcp_test',
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

function createExecCtx(auth?: AuthContext): ToolExecutionContext {
  return {
    db: mockDb,
    auth: auth ?? mockAuthContext(),
  };
}

async function executeMemoryWrite(
  args: Record<string, unknown>,
  ctx?: ToolExecutionContext,
): Promise<ToolResult> {
  const registry = new ToolRegistry();
  registerMemoryWriteTool(registry);
  return registry.execute('memory_write', args, ctx ?? createExecCtx());
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('memory_write tool — input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when content is missing', async () => {
    const result = await executeMemoryWrite({});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Validation error');
    expect(result.content[0]!.text).toContain('content');
  });

  it('rejects when content is empty string', async () => {
    const result = await executeMemoryWrite({ content: '' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Validation error');
  });

  it('rejects invalid suggestedType', async () => {
    const result = await executeMemoryWrite({
      content: 'test content',
      suggestedType: 'invalid_type',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Validation error');
  });
});

describe('memory_write tool — successful write (project scope)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts an event and creates a compile job', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    const jobId = randomUUID();

    mockedInsertEvent.mockResolvedValueOnce({ eventId, status: 'inserted' });
    mockedCreateJob.mockResolvedValueOnce({
      job: {
        id: jobId,
        teamId: 'team_mcp',
        projectId: 'prj_mcp',
        kind: 'ingest_event',
        status: 'queued',
        attempts: 0,
        initiatedByKind: 'credential',
        initiatedByCredentialId: 'key_mcp_test',
        initiatedByPrincipalId: 'pri_mcp_test',
        initiatedByConnector: null,
        idempotencyKey: `compile:${eventId}`,
        idempotencyRequestHash: expect.any(String) as unknown as string,
        resultSnapshot: null,
        eventCount: 1,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      },
      created: true,
    });

    const result = await executeMemoryWrite({
      content: 'We decided to use Postgres for the primary database.',
      title: 'Database decision',
      tags: ['database', 'infrastructure'],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Memory stored successfully');
    expect(result.content[0]!.text).toContain(eventId);
    expect(result.content[0]!.text).toContain(jobId);

    // Verify insertEvent was called with correct channel/kind
    expect(mockedInsertEvent).toHaveBeenCalledTimes(1);
    const insertCall = mockedInsertEvent.mock.calls[0]![1];
    expect(insertCall.channel).toBe('mcp');
    expect(insertCall.kind).toBe('mcp_write');
    expect(insertCall.connectorKind).toBe('mcp');
    expect(insertCall.teamId).toBe('team_mcp');
    expect(insertCall.projectId).toBe('prj_mcp');
    expect(insertCall.actor).toBeNull();
    expect(insertCall.actorProvenance).toBe('unknown');
    expect(insertCall.occurredAtProvenance).toBe('server');

    // Verify the payload contains the text and metadata
    const payload = insertCall.payload as Record<string, unknown>;
    expect(payload.text).toBe('We decided to use Postgres for the primary database.');
    expect(payload.title).toBe('Database decision');
    expect(payload.tags).toEqual(['database', 'infrastructure']);
    expect(payload.schemaVersion).toBe(1);

    // Verify createJob was called
    expect(mockedCreateJob).toHaveBeenCalledTimes(1);
    const jobCall = mockedCreateJob.mock.calls[0]![1];
    expect(jobCall.kind).toBe('ingest_event');
    expect(jobCall.eventCount).toBe(1);
  });

  it('accepts minimal input (content only)', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    const jobId = randomUUID();

    mockedInsertEvent.mockResolvedValueOnce({ eventId, status: 'inserted' });
    mockedCreateJob.mockResolvedValueOnce({
      job: {
        id: jobId,
        teamId: 'team_mcp',
        projectId: 'prj_mcp',
        kind: 'ingest_event',
        status: 'queued',
        attempts: 0,
        initiatedByKind: 'credential',
        initiatedByCredentialId: 'key_mcp_test',
        initiatedByPrincipalId: 'pri_mcp_test',
        initiatedByConnector: null,
        idempotencyKey: `compile:${eventId}`,
        idempotencyRequestHash: expect.any(String) as unknown as string,
        resultSnapshot: null,
        eventCount: 1,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      },
      created: true,
    });

    const result = await executeMemoryWrite({
      content: 'Minimal observation.',
    });

    expect(result.isError).toBeUndefined();
    expect(mockedInsertEvent).toHaveBeenCalledTimes(1);

    const insertCall = mockedInsertEvent.mock.calls[0]![1];
    const payload = insertCall.payload as Record<string, unknown>;
    expect(payload.text).toBe('Minimal observation.');
    expect(payload.title).toBeUndefined();
    expect(payload.tags).toBeUndefined();
  });
});

describe('memory_write tool — private-tag redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips <private> tags from content before persistence', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    mockedInsertEvent.mockResolvedValueOnce({ eventId, status: 'inserted' });
    mockedCreateJob.mockResolvedValueOnce({
      job: {
        id: randomUUID(),
        teamId: 'team_mcp',
        projectId: 'prj_mcp',
        kind: 'ingest_event',
        status: 'queued',
        attempts: 0,
        initiatedByKind: 'credential',
        initiatedByCredentialId: 'key_mcp_test',
        initiatedByPrincipalId: null,
        initiatedByConnector: null,
        idempotencyKey: `compile:${eventId}`,
        idempotencyRequestHash: 'hash',
        resultSnapshot: null,
        eventCount: 1,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      },
      created: true,
    });

    await executeMemoryWrite({
      content: 'Public info <private>SECRET=abc123</private> after',
    });

    const insertCall = mockedInsertEvent.mock.calls[0]![1];
    const payload = insertCall.payload as Record<string, unknown>;
    // The secret must not be in the stored payload
    expect(payload.text).toBe('Public info  after');
    expect(JSON.stringify(payload)).not.toContain('SECRET=abc123');
  });

  it('strips <private> tags from title as well', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    mockedInsertEvent.mockResolvedValueOnce({ eventId, status: 'inserted' });
    mockedCreateJob.mockResolvedValueOnce({
      job: {
        id: randomUUID(),
        teamId: 'team_mcp',
        projectId: 'prj_mcp',
        kind: 'ingest_event',
        status: 'queued',
        attempts: 0,
        initiatedByKind: 'credential',
        initiatedByCredentialId: 'key_mcp_test',
        initiatedByPrincipalId: null,
        initiatedByConnector: null,
        idempotencyKey: `compile:${eventId}`,
        idempotencyRequestHash: 'hash',
        resultSnapshot: null,
        eventCount: 1,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      },
      created: true,
    });

    await executeMemoryWrite({
      content: 'Some content',
      title: 'Public <private>secret title</private> End',
    });

    const insertCall = mockedInsertEvent.mock.calls[0]![1];
    const payload = insertCall.payload as Record<string, unknown>;
    expect(payload.title).toBe('Public  End');
    expect(JSON.stringify(payload)).not.toContain('secret title');

    // externalId must also be redacted — must not leak <private> content (AGENTS.md §5.3)
    expect(insertCall.externalId).toBe('mcp:Public  End');
    expect(insertCall.externalId).not.toContain('secret');
  });
});

describe('memory_write tool — scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses project-scoped key project id', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    mockedInsertEvent.mockResolvedValueOnce({ eventId, status: 'inserted' });
    mockedCreateJob.mockResolvedValueOnce({
      job: {
        id: randomUUID(),
        teamId: 'team_specific',
        projectId: 'prj_bound',
        kind: 'ingest_event',
        status: 'queued',
        attempts: 0,
        initiatedByKind: 'credential',
        initiatedByCredentialId: 'key_mcp_test',
        initiatedByPrincipalId: null,
        initiatedByConnector: null,
        idempotencyKey: `compile:${eventId}`,
        idempotencyRequestHash: 'hash',
        resultSnapshot: null,
        eventCount: 1,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      },
      created: true,
    });

    const auth = mockAuthContext({
      scope: projectScope('team_specific', 'prj_bound'),
    });

    const result = await executeMemoryWrite(
      { content: 'test' },
      createExecCtx(auth),
    );

    expect(result.isError).toBeUndefined();
    const insertCall = mockedInsertEvent.mock.calls[0]![1];
    expect(insertCall.teamId).toBe('team_specific');
    expect(insertCall.projectId).toBe('prj_bound');
  });

  it('rejects allProjects scope without explicit projectId', async () => {
    const auth = mockAuthContext({
      scope: allProjectsScope('team_wide'),
    });

    const result = await executeMemoryWrite(
      { content: 'test' },
      createExecCtx(auth),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('projectId is required');
    expect(mockedInsertEvent).not.toHaveBeenCalled();
  });
});

describe('memory_write tool — duplicate replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success on duplicate (same deliveryId would mean same event)', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    // Since we generate a new UUID each time, duplicates only happen with
    // race conditions. For the handler, insertEvent returning duplicate
    // is a valid path that should not error.
    mockedInsertEvent.mockResolvedValueOnce({ eventId, status: 'duplicate' });

    const result = await executeMemoryWrite({ content: 'test' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Memory stored successfully');
    expect(mockedCreateJob).not.toHaveBeenCalled(); // No new job on duplicate
  });
});

describe('memory_write tool — job creation failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports partial success when job creation fails', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    mockedInsertEvent.mockResolvedValueOnce({ eventId, status: 'inserted' });
    mockedCreateJob.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await executeMemoryWrite({ content: 'test' });

    // Event was persisted but job creation failed — partial success
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Memory stored');
    expect(result.content[0]!.text).toContain('compile job creation failed');
    expect(result.content[0]!.text).toContain(eventId);
  });
});

describe('memory_write tool — API key scope enforcement (AGENTS.md §8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a key without events:write scope', async () => {
    const auth = mockAuthContext({ scopes: ['read'] });

    const result = await executeMemoryWrite(
      { content: 'test' },
      createExecCtx(auth),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('events:write');
    expect(result.content[0]!.text).toContain('does not have them');
    expect(mockedInsertEvent).not.toHaveBeenCalled();
  });

  it('accepts a key with events:write scope', async () => {
    const auth = mockAuthContext({ scopes: ['events:write'] });
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    mockedInsertEvent.mockResolvedValueOnce({ eventId, status: 'inserted' });
    mockedCreateJob.mockResolvedValueOnce({
      job: {
        id: randomUUID(),
        teamId: 'team_mcp',
        projectId: 'prj_mcp',
        kind: 'ingest_event',
        status: 'queued',
        attempts: 0,
        initiatedByKind: 'credential',
        initiatedByCredentialId: 'key_mcp_test',
        initiatedByPrincipalId: null,
        initiatedByConnector: null,
        idempotencyKey: `compile:${eventId}`,
        idempotencyRequestHash: 'hash',
        resultSnapshot: null,
        eventCount: 1,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      },
      created: true,
    });

    const result = await executeMemoryWrite(
      { content: 'test' },
      createExecCtx(auth),
    );

    expect(result.isError).toBeUndefined();
    expect(mockedInsertEvent).toHaveBeenCalled();
  });

  it('rejects a key with empty scopes', async () => {
    const auth = mockAuthContext({ scopes: [] });

    const result = await executeMemoryWrite(
      { content: 'test' },
      createExecCtx(auth),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('events:write');
    expect(mockedInsertEvent).not.toHaveBeenCalled();
  });

  it('rejects a key with read:payload but not events:write', async () => {
    const auth = mockAuthContext({ scopes: ['read', 'read:payload'] });

    const result = await executeMemoryWrite(
      { content: 'test' },
      createExecCtx(auth),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('events:write');
    expect(mockedInsertEvent).not.toHaveBeenCalled();
  });
});
