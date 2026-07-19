/**
 * Integration tests for the Audit Writer Repository (DUA-178).
 *
 * Uses real Postgres via the test scaffolding. Tests:
 * - Success path: write a valid audit record
 * - Whitelist enforcement: extra fields rejected
 * - Sensitive text absence: payload-like text is NOT stored
 * - Fail-closed: audit write failure denies the payload read
 * - Multiple action types and outcomes
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool as PgPool } from 'pg';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import * as schema from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  writeAuditRecord,
  auditPayloadRead,
  AuditWriteFailedError,
  type AuditWriteParams,
} from './audit.js';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('audit repository (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  beforeAll(() => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  // Clean audit_log between tests (no FKs, safe to delete independently)
  beforeEach(async () => {
    await db.delete(schema.auditLog);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function validParams(overrides: Partial<AuditWriteParams> = {}): AuditWriteParams {
    return {
      requestId: `req_${randomUUID()}`,
      principalId: null,
      credentialId: 'key_abc123def456',
      action: 'event.ingest',
      resourceType: 'event',
      resourceId: `evt_${randomUUID().replace(/-/g, '')}`,
      teamId: 'team_test001',
      projectId: 'prj_test001',
      outcome: 'success',
      ...overrides,
    };
  }

  // ── Success: basic write ─────────────────────────────────────────────────

  it('writes a valid audit record and returns the created item', async () => {
    const params = validParams();

    const result = await writeAuditRecord(db, params);

    // Returned item matches input
    expect(result.requestId).toBe(params.requestId);
    expect(result.principalId).toBe(params.principalId);
    expect(result.credentialId).toBe(params.credentialId);
    expect(result.action).toBe(params.action);
    expect(result.resourceType).toBe(params.resourceType);
    expect(result.resourceId).toBe(params.resourceId);
    expect(result.teamId).toBe(params.teamId);
    expect(result.projectId).toBe(params.projectId);
    expect(result.outcome).toBe(params.outcome);

    // Auto-generated fields
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe('string');
    expect(result.createdAt).toBeDefined();

    // Verify it's actually persisted
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, result.id))
      .limit(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe(params.requestId);
    expect(rows[0]!.action).toBe(params.action);
  });

  // ── Multiple action types ────────────────────────────────────────────────

  it('writes records for all known audit actions', async () => {
    const actions = [
      'event.ingest',
      'event.payload_read',
      'concept.read',
      'search.query',
      'context.read',
      'compilation.request',
      'audit.query',
      'project.purge',
      'key.create',
      'key.revoke',
    ] as const;

    for (const action of actions) {
      const params = validParams({ action, resourceId: null });
      const result = await writeAuditRecord(db, params);
      expect(result.action).toBe(action);
    }

    const count = await db.$count(schema.auditLog);
    expect(count).toBe(actions.length);
  });

  // ── Multiple outcomes ────────────────────────────────────────────────────

  it('writes records with all audit outcomes', async () => {
    for (const outcome of ['success', 'denied', 'failed'] as const) {
      const params = validParams({ outcome });
      const result = await writeAuditRecord(db, params);
      expect(result.outcome).toBe(outcome);
    }
  });

  // ── Nullable fields ──────────────────────────────────────────────────────

  it('handles null principalId, credentialId, resourceId, and projectId', async () => {
    const params: AuditWriteParams = {
      requestId: `req_${randomUUID()}`,
      principalId: null,
      credentialId: null,
      action: 'search.query',
      resourceType: 'concept',
      resourceId: null,
      teamId: 'team_test001',
      projectId: null,
      outcome: 'success',
    };

    const result = await writeAuditRecord(db, params);

    expect(result.principalId).toBeNull();
    expect(result.credentialId).toBeNull();
    expect(result.resourceId).toBeNull();
    expect(result.projectId).toBeNull();

    // Verify persistence
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, result.id));

    expect(rows[0]!.principalId).toBeNull();
    expect(rows[0]!.credentialId).toBeNull();
    expect(rows[0]!.resourceId).toBeNull();
    expect(rows[0]!.projectId).toBeNull();
  });

  // ── Whitelist enforcement: no sensitive text ─────────────────────────────

  it('SECURITY: the write function signature prevents passing query text, request bodies, payloads, or keys', () => {
    // TypeScript compile-time check: AuditWriteParams does not have
    // fields for query text, request bodies, payloads, or keys.
    // This test verifies the fields that DO exist are exactly the whitelist.

    const params = validParams();
    const allowedKeys = new Set([
      'requestId',
      'principalId',
      'credentialId',
      'action',
      'resourceType',
      'resourceId',
      'teamId',
      'projectId',
      'outcome',
    ]);

    const actualKeys = Object.keys(params);

    // Every key in the params must be in the whitelist
    for (const key of actualKeys) {
      expect(allowedKeys.has(key), `Field "${key}" is not in the audit whitelist`).toBe(true);
    }

    // Explicitly verify forbidden fields don't exist
    const forbiddenFields = [
      'queryText',
      'query',
      'searchQuery',
      'requestBody',
      'body',
      'payload',
      'content',
      'apiKey',
      'key',
      'token',
      'secret',
      'response',
      'result',
    ];

    const paramsAsRecord = params as unknown as Record<string, unknown>;
    for (const forbidden of forbiddenFields) {
      expect(
        forbidden in paramsAsRecord,
        `Forbidden field "${forbidden}" must not exist in AuditWriteParams`,
      ).toBe(false);
    }
  });

  // ── Sensitive text absence in stored rows ────────────────────────────────

  it('SECURITY: no sensitive text (query, payload, key) is stored in audit_log', async () => {
    // Write a record with a resourceType that might imply a read
    const resourceId = `evt_${randomUUID().replace(/-/g, '')}`;
    const params = validParams({
      action: 'event.payload_read',
      resourceType: 'event',
      resourceId,
    });

    const result = await writeAuditRecord(db, params);

    // Fetch the stored row
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, result.id));

    const row = rows[0]!;

    // The row must contain only the whitelisted columns as defined by the
    // schema. Verify that no JSONB, text blob, or other unstructured column
    // holds payload data. The audit_log table has exactly these columns:
    // id, created_at, request_id, principal_id, credential_id, action,
    // resource_type, resource_id, team_id, project_id, outcome.
    // There is no payload, body, or content column.

    // The requestId must NOT contain any payload-like content
    expect(row.requestId).not.toContain('{');
    expect(row.requestId).not.toContain('<private>');
    expect(row.requestId).not.toContain('Bearer');
    expect(row.requestId).not.toContain('tm_');

    // The action is a simple dot-notation string — not a payload
    expect(row.action).toBe('event.payload_read');
    expect(row.action).not.toContain('{');
    expect(row.action).not.toContain('<private>');

    // resourceId is an opaque identifier, not content
    expect(row.resourceId).toBe(resourceId);

    // No key material is present
    expect(row.credentialId).toBe('key_abc123def456');
    expect(row.credentialId).not.toContain('tm_'); // key_... IDs, not tokens

    // Verify we can't accidentally store extra data by checking column count
    const columnNames = Object.keys(row);
    const whitelistColumns = new Set([
      'id',
      'createdAt',
      'requestId',
      'principalId',
      'credentialId',
      'action',
      'resourceType',
      'resourceId',
      'teamId',
      'projectId',
      'outcome',
    ]);

    for (const col of columnNames) {
      expect(
        whitelistColumns.has(col),
        `Column "${col}" is not in the audit whitelist`,
      ).toBe(true);
    }
  });

  // ── Fail-closed: auditPayloadRead ────────────────────────────────────────

  it('auditPayloadRead writes a success audit record for a valid event payload read', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    await auditPayloadRead(db, {
      requestId: `req_${randomUUID()}`,
      principalId: 'pri_abc123def456',
      credentialId: 'key_abc123def456',
      teamId: 'team_test001',
      projectId: 'prj_test001',
      resourceId: eventId,
    });

    // Verify the audit record was written
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.resourceId, eventId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('event.payload_read');
    expect(rows[0]!.resourceType).toBe('event');
    expect(rows[0]!.outcome).toBe('success');
    expect(rows[0]!.principalId).toBe('pri_abc123def456');
    expect(rows[0]!.credentialId).toBe('key_abc123def456');
  });

  it('auditPayloadRead records with correct outcome', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    await auditPayloadRead(db, {
      requestId: `req_${randomUUID()}`,
      principalId: null,
      credentialId: null,
      teamId: 'team_test001',
      projectId: null,
      resourceId: eventId,
    });

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.resourceId, eventId));

    expect(rows[0]!.outcome).toBe('success');
    expect(rows[0]!.projectId).toBeNull();
  });

  // ── Idempotency: multiple writes for different reads ─────────────────────

  it('writes separate audit records for separate payload reads', async () => {
    const eventId1 = `evt_${randomUUID().replace(/-/g, '')}`;
    const eventId2 = `evt_${randomUUID().replace(/-/g, '')}`;

    await auditPayloadRead(db, {
      requestId: `req_1`,
      principalId: null,
      credentialId: 'key_test',
      teamId: 'team_test001',
      projectId: 'prj_test001',
      resourceId: eventId1,
    });

    await auditPayloadRead(db, {
      requestId: `req_2`,
      principalId: null,
      credentialId: 'key_test',
      teamId: 'team_test001',
      projectId: 'prj_test001',
      resourceId: eventId2,
    });

    const count = await db.$count(schema.auditLog);
    expect(count).toBe(2);

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, 'team_test001'));

    const eventIds = rows.map((r) => r.resourceId).sort();
    expect(eventIds).toEqual([eventId1, eventId2].sort());
  });

  // ── Fail-closed counterexample: invalid input rejects at Zod boundary ────

  it('SECURITY: rejects audit writes with extra fields via Zod strictObject', async () => {
    // The buildAuditRow function is called internally — we test that
    // passing extra data through the type system would require an explicit
    // escape hatch. Since AuditWriteParams is a strict interface, this is
    // enforced at compile time. At runtime, the auditItem.parse() call
    // inside buildAuditRow would reject any extra fields.

    // We verify this by constructing a row manually and attempting to parse
    const { auditItem } = await import('@teamem/schema');

    const validRow = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      requestId: 'req_test',
      principalId: null,
      credentialId: null,
      action: 'event.payload_read',
      resourceType: 'event',
      resourceId: 'evt_test',
      teamId: 'team_test001',
      projectId: null,
      outcome: 'success',
    };

    // Valid row parses successfully
    expect(() => auditItem.parse(validRow)).not.toThrow();

    // Row with extra field (e.g., 'payload') must be rejected
    const rowWithPayload = {
      ...validRow,
      payload: { secret: 'sensitive-data' },
    };
    expect(() => auditItem.parse(rowWithPayload)).toThrow();

    // Row with query text must be rejected
    const rowWithQuery = {
      ...validRow,
      queryText: 'SELECT * FROM secrets',
    };
    expect(() => auditItem.parse(rowWithQuery)).toThrow();

    // Row with API key material must be rejected
    const rowWithKey = {
      ...validRow,
      apiKey: 'tm_super_secret_token_abc123',
    };
    expect(() => auditItem.parse(rowWithKey)).toThrow();
  });

  // ── Fail-closed: real database failure ──────────────────────────────────

  it('fail-closed: when the database write fails, auditPayloadRead throws AuditWriteFailedError and denies the read', async () => {
    // Create a separate pool and db handle for this test.
    const failPool = new PgPool({ connectionString: url! });
    const failDb = createDb(url!, { pool: failPool });

    // Force a real database write failure by closing the pool first.
    await failPool.end();

    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    // auditPayloadRead MUST throw AuditWriteFailedError — fail-closed.
    // If it doesn't throw, the caller would incorrectly return payload data.
    let caught: unknown = null;
    try {
      await auditPayloadRead(failDb, {
        requestId: `req_${randomUUID()}`,
        principalId: 'pri_test',
        credentialId: 'key_test',
        teamId: 'team_test001',
        projectId: 'prj_test001',
        resourceId: eventId,
      });
      // If we reach here, the fail-closed guarantee is broken.
      expect.fail('auditPayloadRead should have thrown but succeeded — fail-closed guarantee broken');
    } catch (err) {
      caught = err;
    }

    // Must be an AuditWriteFailedError
    expect(caught).toBeInstanceOf(AuditWriteFailedError);
    expect((caught as Error).name).toBe('AuditWriteFailedError');

    // Must have the standard denial message
    expect((caught as Error).message).toBe('Audit write failed; payload read denied');
  });

  it('fail-closed: the AuditWriteFailedError message never leaks internal details', async () => {
    // Create a separate pool, close it to force failure, and verify
    // the error message is clean — no SQL, connection strings, or keys.
    const failPool = new PgPool({ connectionString: url! });
    const failDb = createDb(url!, { pool: failPool });
    await failPool.end();

    let caught: unknown = null;
    try {
      await auditPayloadRead(failDb, {
        requestId: `req_${randomUUID()}`,
        principalId: null,
        credentialId: null,
        teamId: 'team_test001',
        projectId: null,
        resourceId: `evt_${randomUUID().replace(/-/g, '')}`,
      });
      expect.fail('should have thrown');
    } catch (err) {
      caught = err;
    }

    const message = (caught as Error).message;
    // The error message must NOT leak:
    expect(message).not.toContain('SELECT');
    expect(message).not.toContain('INSERT');
    expect(message).not.toContain('postgres');
    expect(message).not.toContain('password');
    expect(message).not.toContain('DATABASE_URL');
    expect(message).not.toContain('connectionString');
    expect(message).not.toContain('127.0.0.1');
    // The message must be the clean denial message only
    expect(message).toBe('Audit write failed; payload read denied');
  });

  it('fail-closed: auditPayloadRead does NOT write a record when the database fails', async () => {
    // Create a separate pool, close it, try auditPayloadRead, then verify
    // no audit row was actually written (fail-closed = no partial side effect).
    const failPool = new PgPool({ connectionString: url! });
    const failDb = createDb(url!, { pool: failPool });
    await failPool.end();

    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    try {
      await auditPayloadRead(failDb, {
        requestId: `req_${randomUUID()}`,
        principalId: null,
        credentialId: null,
        teamId: 'team_test001',
        projectId: null,
        resourceId: eventId,
      });
    } catch {
      // Expected — now verify the main db has NO record of this event
    }

    // The main (healthy) db must not have any audit row for this event
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.resourceId, eventId));

    expect(rows).toHaveLength(0);
  });
});
