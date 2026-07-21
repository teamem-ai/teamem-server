/**
 * Bootstrap command integration tests (DUA-175 / M0-DATA-02).
 *
 * Tests the full bootstrap pipeline against real Postgres — no mock databases,
 * per project red line. Covers:
 *  - Success path: first run creates all entities, prints token
 *  - Idempotency: second run reuses entities, does NOT print token
 *  - Rotation: --rotate revokes old key, mints new one with fresh token
 *  - Security: only SHA-256 hash stored in database, no plaintext persisted
 *  - Boundary: missing required args fail fast
 *  - Tenant isolation: independent teams/projects don't collide
 *
 * Honesty: skipped when TEST_DATABASE_URL is absent (no mock DB fallback).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDb, type AppDb } from '../db/client.js';
import {
  connectDatabase,
  closeDatabase as closeTestPool,
  type Pool,
} from '../test/database.js';
import { eq, and, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { hashToken } from '../auth/api-key.js';
import {
  runBootstrap,
  parseBootstrapArgs,
  type BootstrapArgs,
} from './bootstrap.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('bootstrap command (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  beforeAll(() => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });
  });

  afterAll(async () => {
    // The db wraps the pool; closing the pool is sufficient — do NOT
    // also call closeDb(db) because that would end the pool twice.
    await closeTestPool(pool);
  });

  beforeEach(async () => {
    // Clean data in full FK dependency order. The postgres CI job runs all
    // integration files against one database, so this setup must tolerate rows
    // left by earlier repository tests.
    await db.delete(schema.jobEvents);
    await db.delete(schema.jobs);
    await db.delete(schema.conceptContributors);
    await db.delete(schema.conceptEvidence);
    await db.delete(schema.conceptPaths);
    await db.delete(schema.concepts);
    await db.delete(schema.events);
    await db.delete(schema.apiKeys);
    await db.delete(schema.principals);
    await db.delete(schema.projects);
    await db.delete(schema.teams);
  });

  // ── Success path: first run creates everything ─────────────────────────

  it('creates team, project, and key on first run; prints token exactly once', async () => {
    const args: BootstrapArgs = {
      teamName: 'M0 Test Team',
      projectName: 'demo',
      rotate: false,
    };

    const result = await runBootstrap(db, args);

    // Team
    expect(result.team.action).toBe('created');
    expect(result.team.name).toBe('M0 Test Team');
    expect(result.team.id).toMatch(/^team_[A-Za-z0-9]+$/);

    // Project
    expect(result.project.action).toBe('created');
    expect(result.project.name).toBe('demo');
    expect(result.project.id).toMatch(/^prj_[A-Za-z0-9]+$/);

    // Key
    expect(result.key.action).toBe('created');
    expect(result.key.name).toBe('M0 Bootstrap Key');
    expect(result.key.scopes).toContain('read');
    expect(result.key.scopes).toContain('read:payload');
    expect(result.key.scopes).toContain('events:write');
    expect(result.key.allProjects).toBe(false);

    // Token printed exactly once on creation
    expect(result.key.token).toBeDefined();
    expect(result.key.token).toMatch(/^tm_[A-Za-z0-9_-]{40,}$/);

    // MCP add command (DUA-211): present when token is present
    expect(result.key.mcpAddCommand).toBeDefined();
    expect(result.key.mcpAddCommand).toContain('claude mcp add --transport http teamem');
    expect(result.key.mcpAddCommand).toContain(`--header "Authorization: Bearer ${result.key.token}"`);
    expect(result.key.mcpAddCommand).toMatch(/http:\/\/[^:]+:\d+\/mcp/);

    // Verify only hash is stored in DB
    const tokenHash = hashToken(result.key.token!);
    const dbKeys = await db
      .select({ tokenHash: schema.apiKeys.tokenHash })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, result.key.id))
      .limit(1);

    expect(dbKeys[0]!.tokenHash).toBe(tokenHash);
    // The plaintext token should NOT appear anywhere in the DB
    expect(dbKeys[0]!.tokenHash).not.toBe(result.key.token);
  });

  it('creates optional service principal when --principal-name is provided', async () => {
    const args: BootstrapArgs = {
      teamName: 'M0 With Principal',
      projectName: 'demo',
      principalName: 'my-service',
      rotate: false,
    };

    const result = await runBootstrap(db, args);

    expect(result.principal).not.toBeNull();
    expect(result.principal!.name).toBe('my-service');
    expect(result.principal!.kind).toBe('service');
    expect(result.principal!.action).toBe('created');
    expect(result.principal!.id).toMatch(/^pri_[A-Za-z0-9]+$/);

    // Verify principal exists in DB
    const dbPrincipal = await db
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.teamId, result.team.id),
          eq(schema.principals.providerKind, 'teamem'),
          eq(schema.principals.displayLogin, 'my-service'),
        ),
      )
      .limit(1);

    expect(dbPrincipal[0]).toBeDefined();

    // Key should reference the principal
    const dbKey = await db
      .select({ principalId: schema.apiKeys.principalId })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, result.key.id))
      .limit(1);

    expect(dbKey[0]!.principalId).toBe(result.principal!.id);
  });

  // ── Idempotency: second run reuses entities ────────────────────────────

  it('reuses existing team, project, principal, and key on second run (no token leaked)', async () => {
    const args: BootstrapArgs = {
      teamName: 'M0 Idempotent',
      projectName: 'demo',
      principalName: 'my-service',
      rotate: false,
    };

    // First run
    const first = await runBootstrap(db, args);
    expect(first.team.action).toBe('created');
    expect(first.project.action).toBe('created');
    expect(first.principal!.action).toBe('created');
    expect(first.key.action).toBe('created');
    expect(first.key.token).toBeDefined();

    const firstToken = first.key.token;
    const firstKeyId = first.key.id;

    // Second run — same args
    const second = await runBootstrap(db, args);

    // Entities are reused
    expect(second.team.action).toBe('reused');
    expect(second.team.id).toBe(first.team.id);
    expect(second.project.action).toBe('reused');
    expect(second.project.id).toBe(first.project.id);
    expect(second.principal!.action).toBe('reused');
    expect(second.principal!.id).toBe(first.principal!.id);

    // Key is reused — NO token leaked, NO mcpAddCommand
    expect(second.key.action).toBe('reused');
    expect(second.key.id).toBe(firstKeyId);
    expect(second.key.token).toBeUndefined(); // <-- THE critical assertion: no token on replay
    expect(second.key.mcpAddCommand).toBeUndefined(); // <-- DUA-211: no command on replay

    // Verify only ONE key row exists (no duplicate)
    const keyCount = await db
      .select()
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.projectId, first.project.id),
          eq(schema.apiKeys.name, 'M0 Bootstrap Key'),
          isNull(schema.apiKeys.revokedAt),
        ),
      );
    expect(keyCount).toHaveLength(1);

    // The stored hash still matches the first-run token
    const storedHash = keyCount[0]!.tokenHash;
    expect(storedHash).toBe(hashToken(firstToken!));
  });

  // ── Rotation: --rotate revokes old key, mints new one ──────────────────

  it('--rotate revokes the old key and mints a new one with a fresh token', async () => {
    const args: BootstrapArgs = {
      teamName: 'M0 Rotate',
      projectName: 'demo',
      rotate: false,
    };

    // First run — creates key
    const first = await runBootstrap(db, args);
    expect(first.key.action).toBe('created');
    expect(first.key.token).toBeDefined();
    const firstKeyId = first.key.id;
    const firstToken = first.key.token;

    // Second run with --rotate
    const rotateArgs: BootstrapArgs = { ...args, rotate: true };
    const second = await runBootstrap(db, rotateArgs);

    // New key minted — token AND mcpAddCommand present
    expect(second.key.action).toBe('rotated');
    expect(second.key.id).not.toBe(firstKeyId);
    expect(second.key.token).toBeDefined();
    expect(second.key.token).not.toBe(firstToken);
    expect(second.key.mcpAddCommand).toBeDefined();
    expect(second.key.mcpAddCommand).toContain(`--header "Authorization: Bearer ${second.key.token}"`);

    // Old key is now revoked
    const oldKey = await db
      .select({ revokedAt: schema.apiKeys.revokedAt })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, firstKeyId))
      .limit(1);
    expect(oldKey[0]!.revokedAt).not.toBeNull();

    // New key is active
    const newKey = await db
      .select({ revokedAt: schema.apiKeys.revokedAt, tokenHash: schema.apiKeys.tokenHash })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, second.key.id))
      .limit(1);
    expect(newKey[0]!.revokedAt).toBeNull();
    expect(newKey[0]!.tokenHash).toBe(hashToken(second.key.token!));

    // Only the new key is active (non-revoked)
    const activeKeys = await db
      .select()
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.projectId, first.project.id),
          eq(schema.apiKeys.name, 'M0 Bootstrap Key'),
          isNull(schema.apiKeys.revokedAt),
        ),
      );
    expect(activeKeys).toHaveLength(1);
    expect(activeKeys[0]!.id).toBe(second.key.id);
  });

  // ── Security: no plaintext in database ─────────────────────────────────

  it('SECURITY: only SHA-256 hash stored; plaintext token never persisted', async () => {
    const args: BootstrapArgs = {
      teamName: 'M0 Security',
      projectName: 'demo',
      rotate: false,
    };

    const result = await runBootstrap(db, args);
    const token = result.key.token!;

    // Direct DB query: ensure the token_hash column is a 64-char hex string (SHA-256)
    // and NOT the plaintext token
    const rows = await db
      .select({ tokenHash: schema.apiKeys.tokenHash })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, result.key.id));

    const dbHash = rows[0]!.tokenHash;
    // SHA-256 hex is 64 characters
    expect(dbHash).toMatch(/^[a-f0-9]{64}$/);
    // It is NOT the plaintext token
    expect(dbHash).not.toBe(token);

    // Verify the hash is computable from the token
    const computedHash = hashToken(token);
    expect(dbHash).toBe(computedHash);
  });

  // ── Boundary: missing required args ────────────────────────────────────

  it('fails fast when --team-name is missing', () => {
    expect(() => parseBootstrapArgs(['node', 'index.js', '--bootstrap'])).toThrow(
      '--team-name is required',
    );
  });

  it('fails fast when --project-name is missing', () => {
    expect(() =>
      parseBootstrapArgs([
        'node',
        'index.js',
        '--bootstrap',
        '--team-name',
        'M0',
      ]),
    ).toThrow('--project-name is required');
  });

  it('fails when --bootstrap flag is absent', () => {
    expect(() =>
      parseBootstrapArgs(['node', 'index.js', '--team-name', 'M0']),
    ).toThrow('not a bootstrap invocation');
  });

  // ── Tenant isolation: independent runs don't collide ───────────────────

  it('independent team names produce independent teams, projects, and keys', async () => {
    const argsA: BootstrapArgs = {
      teamName: 'Team Alpha',
      projectName: 'demo',
      rotate: false,
    };
    const argsB: BootstrapArgs = {
      teamName: 'Team Beta',
      projectName: 'demo',
      rotate: false,
    };

    const resultA = await runBootstrap(db, argsA);
    const resultB = await runBootstrap(db, argsB);

    // Different teams
    expect(resultA.team.id).not.toBe(resultB.team.id);

    // Different projects (even with same project name, different team scope)
    expect(resultA.project.id).not.toBe(resultB.project.id);

    // Different keys
    expect(resultA.key.id).not.toBe(resultB.key.id);

    // Both tokens are valid and different
    expect(resultA.key.token).toBeDefined();
    expect(resultB.key.token).toBeDefined();
    expect(resultA.key.token).not.toBe(resultB.key.token);
  });

  // ── Principal idempotency across runs ──────────────────────────────────

  it('reuses principal across runs with same principal name', async () => {
    const args: BootstrapArgs = {
      teamName: 'M0 Principal Reuse',
      projectName: 'demo-a',
      principalName: 'shared-service',
      rotate: false,
    };

    // First project run — creates principal
    const first = await runBootstrap(db, args);
    expect(first.principal!.action).toBe('created');

    // Second project, same team, same principal name — reuses principal
    const argsB: BootstrapArgs = {
      teamName: 'M0 Principal Reuse',
      projectName: 'demo-b',
      principalName: 'shared-service',
      rotate: false,
    };
    const second = await runBootstrap(db, argsB);
    expect(second.principal!.action).toBe('reused');
    expect(second.principal!.id).toBe(first.principal!.id);
  });
});
