/**
 * MCP memory_write tool — real-Postgres integration tests (DUA-210 M1-MCP-05).
 *
 * Tests the full memory_write pipeline against real Postgres:
 *   - Successful write with mcp_write event
 *   - Private-tag redaction in stored payload
 *   - Compile job creation
 *   - Scope enforcement & cross-team isolation
 *   - Payload hash computed on redacted content
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 * No mocked database — per project red line.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   psql < apps/server/drizzle/0000_*.sql
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { ToolRegistry, type ToolExecutionContext } from '../registry.js';
import { registerMemoryWriteTool } from './memory_write.js';
import type { AuthContext } from '../../db/repositories/api-keys.js';
import { projectScope, allProjectsScope } from '../../auth/scope.js';
import { payloadHash } from '../../security/payload-hash.js';
import { PAYLOAD_SCHEMA_VERSION } from '@teamem/schema';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('memory_write tool (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  // Per-test-suite stable team and project identifiers.
  // Note: teamId must match /^team_[A-Za-z0-9]+$/ — no extra underscores after the prefix.
  const teamId = `team_mw${randomUUID().replace(/-/g, '')}`;
  const projectId = `prj_mw${randomUUID().replace(/-/g, '')}`;
  const credentialId = `key_mw${randomUUID().replace(/-/g, '')}`;
  const principalId = `pri_mw${randomUUID().replace(/-/g, '')}`;
  // Cross-tenant identifiers — need to be at describe scope for test access.
  const otherTeamId = `team_other${randomUUID().replace(/-/g, '')}`;
  const otherProjectId = `prj_other${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Seed: team and project
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('${teamId}', 'MemoryWrite Test Team') ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${projectId}', '${teamId}', 'MemoryWrite Test Project') ON CONFLICT (id) DO NOTHING`,
    );

    // Seed: principal for ingestedBy attribution
    await db.execute(
      `INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
       VALUES ('${principalId}', '${teamId}', 'service', 'external', 'teamem', 'bootstrap:mw-test', 'mw-test-service')
       ON CONFLICT (id) DO NOTHING`,
    );

    // Seed: second team for cross-tenant isolation tests
    await db.execute(
      `INSERT INTO teams (id, name) VALUES ('${otherTeamId}', 'Other Team') ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${otherProjectId}', '${otherTeamId}', 'Other Project') ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    // Clean up in dependency order
    await db.execute(`DELETE FROM job_events WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM events WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM jobs WHERE team_id = '${teamId}'`);
    await db.execute(`DELETE FROM events WHERE team_id = '${otherTeamId}'`);
    await db.execute(`DELETE FROM principals WHERE id = '${principalId}'`);
    await db.execute(`DELETE FROM projects WHERE id = '${projectId}'`);
    await db.execute(`DELETE FROM projects WHERE id = '${otherProjectId}'`);
    await db.execute(`DELETE FROM teams WHERE id = '${teamId}'`);
    await db.execute(`DELETE FROM teams WHERE id = '${otherTeamId}'`);
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean in FK dependency order: job_events → events → jobs
    await db.execute(
      `DELETE FROM job_events WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM events WHERE team_id = '${teamId}'`,
    );
    await db.execute(
      `DELETE FROM jobs WHERE team_id = '${teamId}'`,
    );
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function mockAuthContext(): AuthContext {
    return {
      credentialId,
      keyName: 'MCP Integration Test Key',
      scopes: ['events:write'],
      scope: projectScope(teamId, projectId),
      principal: {
        id: principalId,
        kind: 'service',
        provider: 'external',
        providerKind: 'teamem',
        providerUserId: 'bootstrap:mw-test',
        displayLogin: 'mw-test-service',
      },
      team: { id: teamId, name: 'MemoryWrite Test Team' },
      createdAt: new Date('2025-06-01T00:00:00.000Z'),
    };
  }

  function createExecCtx(auth?: AuthContext): ToolExecutionContext {
    return {
      db,
      auth: auth ?? mockAuthContext(),
      requestId: 'test-int-req-id',
    };
  }

  async function executeMemoryWrite(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ) {
    const registry = new ToolRegistry();
    registerMemoryWriteTool(registry);
    return registry.execute('memory_write', args, ctx ?? createExecCtx());
  }

  // ── CLI 验收步骤 1: 真实 Postgres 集成测试 ──────────────────────────────

  describe('CLI 验收步骤 1 — private-tag redaction in stored event', () => {
    it('strips <private>SECRET=abc123</private> from content in stored event', async () => {
      const result = await executeMemoryWrite({
        content: 'Public observation <private>SECRET=abc123</private> after secret',
        title: 'Test memory',
      });

      expect(result.isError).toBeUndefined();
      const text = result.content[0]!.text;
      expect(text).toContain('Memory stored successfully');

      // Extract eventId from the result
      const match = /Event: (evt_[A-Za-z0-9]+)/.exec(text);
      expect(match).not.toBeNull();
      const eventId = match![1]!;

      // Verify stored payload does NOT contain the secret
      const { rows } = await db.execute(
        `SELECT payload FROM events WHERE id = '${eventId}'`,
      );
      expect(rows).toHaveLength(1);
      const stored = (rows[0] as Record<string, unknown>)['payload'] as Record<string, unknown>;
      expect(stored.text).toBe('Public observation  after secret');
      expect(JSON.stringify(stored)).not.toContain('SECRET=abc123');

      // The name/credentials must not appear in any event
      const { rows: allRows } = await db.execute(
        `SELECT payload::text as p FROM events WHERE project_id = '${projectId}'`,
      );
      for (const row of allRows) {
        expect((row as Record<string, unknown>)['p']).not.toContain('SECRET=abc123');
      }
    });
  });

  // ── CLI 验收步骤 2: mcp_write event enters compilation queue ─────────────

  describe('CLI 验收步骤 2 — mcp_write event creates compile job', () => {
    it('creates an mcp_write event and a queued compile job', async () => {
      const result = await executeMemoryWrite({
        content: 'We decided to use Postgres as the primary database.',
        title: 'Database decision',
        suggestedType: 'decision',
        tags: ['database', 'infrastructure'],
      });

      expect(result.isError).toBeUndefined();
      const text = result.content[0]!.text;
      expect(text).toContain('Memory stored successfully');

      // Extract eventId and jobId
      const eventMatch = /Event: (evt_[A-Za-z0-9]+)/.exec(text);
      expect(eventMatch).not.toBeNull();
      const eventId = eventMatch![1]!;

      // Verify the event row
      const { rows: eventRows } = await db.execute(
        `SELECT id, team_id, project_id, channel, kind, connector_kind,
                delivery_id, item_key, external_id, actor, actor_provenance,
                occurred_at_provenance, ingested_by_credential_id,
                ingested_by_principal_id, payload
         FROM events WHERE id = '${eventId}'`,
      );
      expect(eventRows).toHaveLength(1);
      const eventRow = eventRows[0] as Record<string, unknown>;
      expect(eventRow['channel']).toBe('mcp');
      expect(eventRow['kind']).toBe('mcp_write');
      expect(eventRow['connector_kind']).toBe('mcp');
      expect(eventRow['team_id']).toBe(teamId);
      expect(eventRow['project_id']).toBe(projectId);
      expect(eventRow['item_key']).toBe('root');
      expect(eventRow['actor']).toBeNull();
      expect(eventRow['actor_provenance']).toBe('unknown');
      expect(eventRow['occurred_at_provenance']).toBe('server');
      expect(eventRow['ingested_by_credential_id']).toBe(credentialId);
      expect(eventRow['ingested_by_principal_id']).toBe(principalId);

      // Verify deliveryId is a valid UUID
      const deliveryId = eventRow['delivery_id'] as string;
      expect(deliveryId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // Verify payload
      const payload = eventRow['payload'] as Record<string, unknown>;
      expect(payload.text).toBe('We decided to use Postgres as the primary database.');
      expect(payload.title).toBe('Database decision');
      expect(payload.suggestedType).toBe('decision');
      expect(payload.tags).toEqual(['database', 'infrastructure']);
      expect(payload.schemaVersion).toBe(PAYLOAD_SCHEMA_VERSION);

      // Verify compile job was created
      const { rows: jobRows } = await db.execute(
        `SELECT id, kind, status, event_count, project_id, idempotency_key
         FROM jobs WHERE project_id = '${projectId}'`,
      );
      expect(jobRows).toHaveLength(1);
      const jobRow = jobRows[0] as Record<string, unknown>;
      expect(jobRow['kind']).toBe('ingest_event');
      expect(jobRow['status']).toBe('queued');
      expect(jobRow['event_count']).toBe(1);
      expect(jobRow['project_id']).toBe(projectId);
      expect(jobRow['idempotency_key']).toBe(`compile:${eventId}`);
    });

    it('generates unique deliveryIds for each invocation', async () => {
      const result1 = await executeMemoryWrite({ content: 'First observation.' });
      const result2 = await executeMemoryWrite({ content: 'Second observation.' });

      expect(result1.isError).toBeUndefined();
      expect(result2.isError).toBeUndefined();

      const match1 = /Event: (evt_[A-Za-z0-9]+)/.exec(result1.content[0]!.text);
      const match2 = /Event: (evt_[A-Za-z0-9]+)/.exec(result2.content[0]!.text);
      expect(match1).not.toBeNull();
      expect(match2).not.toBeNull();

      const { rows } = await db.execute(
        `SELECT delivery_id FROM events WHERE project_id = '${projectId}' ORDER BY created_at`,
      );
      expect(rows).toHaveLength(2);
      const d1 = (rows[0] as Record<string, unknown>)['delivery_id'] as string;
      const d2 = (rows[1] as Record<string, unknown>)['delivery_id'] as string;
      expect(d1).not.toBe(d2); // Different UUIDs
    });
  });

  // ── CLI 验收步骤 3: scope enforcement & cross-team isolation ────────────

  describe('CLI 验收步骤 3 — scope & cross-team isolation', () => {
    it('uses the project-scoped key project id', async () => {
      const result = await executeMemoryWrite({ content: 'test' });
      expect(result.isError).toBeUndefined();

      const { rows } = await db.execute(
        `SELECT project_id, team_id FROM events WHERE project_id = '${projectId}'`,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row['project_id']).toBe(projectId);
      expect(row['team_id']).toBe(teamId);
    });

    it('rejects allProjects scope without projectId', async () => {
      const auth = mockAuthContext();
      const wideAuth: AuthContext = {
        ...auth,
        scope: allProjectsScope(teamId),
      };

      const result = await executeMemoryWrite(
        { content: 'test' },
        createExecCtx(wideAuth),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('projectId is required');
    });

    it('allProjects scope with valid projectId succeeds', async () => {
      const auth = mockAuthContext();
      const wideAuth: AuthContext = {
        ...auth,
        scope: allProjectsScope(teamId),
      };

      const result = await executeMemoryWrite(
        { content: 'test with projectId', projectId },
        createExecCtx(wideAuth),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('Memory stored successfully');
    });

    it('allProjects scope cannot write to cross-team project', async () => {
      const auth = mockAuthContext();
      const wideAuth: AuthContext = {
        ...auth,
        scope: allProjectsScope(teamId),
      };

      // Try to write to a project belonging to a different team
      const result = await executeMemoryWrite(
        { content: 'test', projectId: otherProjectId },
        createExecCtx(wideAuth),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('not found');
    });

    it('cross-tenant team cannot write to this project', async () => {
      const auth = mockAuthContext();
      const crossTenantAuth: AuthContext = {
        ...auth,
        scope: projectScope(otherTeamId, otherProjectId),
      };

      // This key has scope for a different team — should not be able to
      // write to our test project. The handler writes to the key's own
      // project (otherProjectId), not our test project.
      const result = await executeMemoryWrite(
        { content: 'test' },
        createExecCtx(crossTenantAuth),
      );

      // The write succeeds but goes to the other project.
      // The isolation test is: no events appear under our test projectId.
      expect(result.isError).toBeUndefined();

      const { rows } = await db.execute(
        `SELECT COUNT(*) as cnt FROM events WHERE project_id = '${projectId}'`,
      );
      expect(Number((rows[0] as Record<string, unknown>)['cnt'])).toBe(0);

      // Clean up the other project's events
      await db.execute(`DELETE FROM job_events WHERE team_id = '${otherTeamId}'`);
      await db.execute(`DELETE FROM events WHERE team_id = '${otherTeamId}'`);
      await db.execute(`DELETE FROM jobs WHERE team_id = '${otherTeamId}'`);
    });
  });

  // ── Boundary: payload hash computed on redacted content ──────────────────

  describe('boundary — payload hash', () => {
    it('computes hash on redacted (stripped) content', async () => {
      const result = await executeMemoryWrite({
        content: 'Public <private>secret</private>',
      });

      expect(result.isError).toBeUndefined();
      const match = /Event: (evt_[A-Za-z0-9]+)/.exec(result.content[0]!.text);
      expect(match).not.toBeNull();
      const eventId = match![1]!;

      // Build expected redacted payload
      const expectedRedacted = {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        text: 'Public ',
      };
      const expectedHash = payloadHash(expectedRedacted);

      const { rows } = await db.execute(
        `SELECT payload_hash FROM events WHERE id = '${eventId}'`,
      );
      expect((rows[0] as Record<string, unknown>)['payload_hash']).toBe(expectedHash);

      // Verify the hash is NOT computed on the original (unredacted) content
      const originalPayload = {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        text: 'Public <private>secret</private>',
      };
      const originalHash = payloadHash(originalPayload);
      expect((rows[0] as Record<string, unknown>)['payload_hash']).not.toBe(originalHash);
    });
  });

  // ── Boundary: minimal payload (content only) ─────────────────────────────

  describe('boundary — minimal payload', () => {
    it('stores content-only payload correctly', async () => {
      const result = await executeMemoryWrite({ content: 'Just the facts.' });

      expect(result.isError).toBeUndefined();
      const match = /Event: (evt_[A-Za-z0-9]+)/.exec(result.content[0]!.text);
      expect(match).not.toBeNull();
      const eventId = match![1]!;

      const { rows } = await db.execute(
        `SELECT payload FROM events WHERE id = '${eventId}'`,
      );
      const payload = (rows[0] as Record<string, unknown>)['payload'] as Record<string, unknown>;
      expect(payload.text).toBe('Just the facts.');
      expect(payload.schemaVersion).toBe(PAYLOAD_SCHEMA_VERSION);
    });
  });
});
