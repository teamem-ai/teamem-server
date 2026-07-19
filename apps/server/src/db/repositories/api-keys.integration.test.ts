/**
 * Integration tests for the API Key Auth Repository (DUA-174).
 *
 * Uses real Postgres via the test scaffolding (no mock databases — red line).
 * Tests the full token-hash → AuthContext resolution path, including:
 * - Success path with project scope
 * - Success path with allProjects scope
 * - Principal snapshot resolution (with and without principal)
 * - Revoked key rejection
 * - Unknown token rejection
 * - Cross-tenant isolation (team A's key must not produce team B scope)
 * - Security: unknown vs revoked produce identical errors (no info leakage)
 * - read:payload implies read defense-in-depth
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { hashToken } from '../../auth/api-key.js';
import { isProjectScope, isAllProjectsScope } from '../../auth/scope.js';
import {
  resolveTokenHash,
  touchKeyLastUsed,
  AuthenticationError,
} from './api-keys.js';

// ── Setup ───────────────────────────────────────────────────────────────────

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('api-keys repository (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  let teamCounter = 0;

  beforeAll(() => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function freshTeamId(): string {
    // Zod schema requires /^team_[A-Za-z0-9]+$/ — no underscores after prefix
    const suffix = `${Date.now()}${++teamCounter}`.replace(/[^A-Za-z0-9]/g, '');
    return `team_${suffix}`;
  }

  function freshProjectId(): string {
    // Zod schema requires /^prj_[A-Za-z0-9]+$/ — no underscores after prefix
    const suffix = `${Date.now()}${++teamCounter}${Math.random().toString(36).slice(2, 8)}`.replace(/[^A-Za-z0-9]/g, '');
    return `prj_${suffix}`;
  }

  function freshPrincipalId(): string {
    return `pri_${randomUUID().replace(/-/g, '')}`;
  }

  function freshKeyId(): string {
    return `key_${randomUUID().replace(/-/g, '')}`;
  }

  async function seedTeam(teamId: string, name = 'Test Team'): Promise<void> {
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${teamId}', '${name}')
      ON CONFLICT (id) DO NOTHING
    `);
  }

  async function seedProject(
    teamId: string,
    projectId: string,
    name = 'Test Project',
  ): Promise<void> {
    await db.execute(`
      INSERT INTO projects (id, team_id, name)
      VALUES ('${projectId}', '${teamId}', '${name}')
    `);
  }

  async function seedPrincipal(
    teamId: string,
    principalId: string,
    opts: {
      kind?: string;
      provider?: string;
      providerKind?: string;
      providerUserId?: string;
      displayLogin?: string;
    } = {},
  ): Promise<void> {
    const {
      kind = 'human',
      provider = 'github',
      providerKind = 'github',
      providerUserId = `user_${Math.random().toString(36).slice(2, 10)}`,
      displayLogin = 'testuser',
    } = opts;
    await db.execute(`
      INSERT INTO principals (id, team_id, kind, provider, provider_kind, provider_user_id, display_login)
      VALUES ('${principalId}', '${teamId}', '${kind}', '${provider}', '${providerKind}', '${providerUserId}', '${displayLogin}')
    `);
  }

  async function seedApiKey(opts: {
    id: string;
    teamId: string;
    projectId?: string;
    principalId?: string;
    name: string;
    tokenHash: string;
    scopes: string[];
    allProjects: boolean;
    revokedAt?: string;
  }): Promise<void> {
    const projectIdSql = opts.projectId ? `'${opts.projectId}'` : 'NULL';
    const principalIdSql = opts.principalId ? `'${opts.principalId}'` : 'NULL';
    const revokedAtSql = opts.revokedAt
      ? `'${opts.revokedAt}'`
      : 'NULL';
    const scopesArray = opts.scopes.map((s) => `'${s}'`).join(', ');
    await db.execute(`
      INSERT INTO api_keys (id, team_id, project_id, principal_id, name, token_hash, scopes, all_projects, revoked_at)
      VALUES (
        '${opts.id}',
        '${opts.teamId}',
        ${projectIdSql},
        ${principalIdSql},
        '${opts.name}',
        '${opts.tokenHash}',
        ARRAY[${scopesArray}],
        ${opts.allProjects},
        ${revokedAtSql}
      )
    `);
  }

  // ── Success path: project scope ──────────────────────────────────────────

  it('resolves a valid token hash to a full AuthContext with project scope', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    const keyId = freshKeyId();
    const token = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);

    await seedTeam(teamId);
    await seedProject(teamId, projectId);
    await seedApiKey({
      id: keyId,
      teamId,
      projectId,
      name: 'Test Key',
      tokenHash,
      scopes: ['read', 'events:write'],
      allProjects: false,
    });

    const ctx = await resolveTokenHash(db, tokenHash);

    expect(ctx.credentialId).toBe(keyId);
    expect(ctx.keyName).toBe('Test Key');
    expect(ctx.scopes).toEqual(['read', 'events:write']);
    expect(ctx.team.id).toBe(teamId);
    expect(ctx.team.name).toBe('Test Team');
    expect(ctx.principal).toBeNull();
    expect(ctx.createdAt).toBeInstanceOf(Date);

    // Scope should be a project scope
    expect(ctx.scope.kind).toBe('project');
    expect(isProjectScope(ctx.scope)).toBe(true);
    if (isProjectScope(ctx.scope)) {
      expect(ctx.scope.teamId).toBe(teamId);
      expect(ctx.scope.projectId).toBe(projectId);
    }
  });

  // ── Success path: allProjects scope ──────────────────────────────────────

  it('resolves an all-projects key to an AllProjectsScope', async () => {
    const teamId = freshTeamId();
    const keyId = freshKeyId();
    const token = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);

    await seedTeam(teamId);
    await seedApiKey({
      id: keyId,
      teamId,
      name: 'All-Projects Key',
      tokenHash,
      scopes: ['read', 'events:write', 'read:payload'],
      allProjects: true,
    });

    const ctx = await resolveTokenHash(db, tokenHash);

    expect(ctx.credentialId).toBe(keyId);
    expect(ctx.scope.kind).toBe('allProjects');
    expect(isAllProjectsScope(ctx.scope)).toBe(true);
    if (isAllProjectsScope(ctx.scope)) {
      expect(ctx.scope.teamId).toBe(teamId);
    }
    // read:payload with read is valid
    expect(ctx.scopes).toContain('read:payload');
    expect(ctx.scopes).toContain('read');
  });

  // ── Principal snapshot ───────────────────────────────────────────────────

  it('includes a principal snapshot when the key has a bound principal', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    const principalId = freshPrincipalId();
    const keyId = freshKeyId();
    const token = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);

    await seedTeam(teamId);
    await seedProject(teamId, projectId);
    await seedPrincipal(teamId, principalId, {
      displayLogin: 'alice',
      providerUserId: 'gh_12345',
    });
    await seedApiKey({
      id: keyId,
      teamId,
      projectId,
      principalId,
      name: 'Alice Key',
      tokenHash,
      scopes: ['read'],
      allProjects: false,
    });

    const ctx = await resolveTokenHash(db, tokenHash);

    expect(ctx.principal).not.toBeNull();
    expect(ctx.principal!.id).toBe(principalId);
    expect(ctx.principal!.kind).toBe('human');
    expect(ctx.principal!.provider).toBe('github');
    expect(ctx.principal!.providerKind).toBe('github');
    expect(ctx.principal!.providerUserId).toBe('gh_12345');
    expect(ctx.principal!.displayLogin).toBe('alice');
  });

  it('returns null principal when key has no bound principal', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    const keyId = freshKeyId();
    const token = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);

    await seedTeam(teamId);
    await seedProject(teamId, projectId);
    await seedApiKey({
      id: keyId,
      teamId,
      projectId,
      name: 'No-Principal Key',
      tokenHash,
      scopes: ['read'],
      allProjects: false,
    });

    const ctx = await resolveTokenHash(db, tokenHash);
    expect(ctx.principal).toBeNull();
  });

  // ── Failure: unknown token ───────────────────────────────────────────────

  it('throws AuthenticationError for an unknown token hash', async () => {
    const fakeHash = hashToken('tm_nonexistent_token_abc123');

    await expect(resolveTokenHash(db, fakeHash)).rejects.toThrow(
      AuthenticationError,
    );
    await expect(resolveTokenHash(db, fakeHash)).rejects.toThrow(
      'invalid or revoked API key',
    );
  });

  // ── Failure: revoked key ─────────────────────────────────────────────────

  it('throws AuthenticationError for a revoked key', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    const keyId = freshKeyId();
    const token = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);

    await seedTeam(teamId);
    await seedProject(teamId, projectId);
    await seedApiKey({
      id: keyId,
      teamId,
      projectId,
      name: 'Revoked Key',
      tokenHash,
      scopes: ['read'],
      allProjects: false,
      revokedAt: '2025-01-01T00:00:00.000Z',
    });

    await expect(resolveTokenHash(db, tokenHash)).rejects.toThrow(
      AuthenticationError,
    );
    await expect(resolveTokenHash(db, tokenHash)).rejects.toThrow(
      'invalid or revoked API key',
    );
  });

  // ── Security: no information leakage ─────────────────────────────────────

  it('SECURITY: unknown and revoked tokens produce identical error messages', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    const keyId = freshKeyId();
    const token = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);

    await seedTeam(teamId);
    await seedProject(teamId, projectId);
    await seedApiKey({
      id: keyId,
      teamId,
      projectId,
      name: 'Revoked Key',
      tokenHash,
      scopes: ['read'],
      allProjects: false,
      revokedAt: '2025-01-01T00:00:00.000Z',
    });

    const fakeHash = hashToken('tm_completely_different_token');

    let revokedError = '';
    let unknownError = '';
    try {
      await resolveTokenHash(db, tokenHash);
    } catch (err) {
      revokedError = (err as Error).message;
    }
    try {
      await resolveTokenHash(db, fakeHash);
    } catch (err) {
      unknownError = (err as Error).message;
    }

    expect(revokedError).toBe(unknownError);
    expect(revokedError).toBe('invalid or revoked API key');
  });

  // ── Cross-tenant isolation ───────────────────────────────────────────────

  it('SECURITY counterexample: team A key cannot produce team B scope', async () => {
    const teamA = freshTeamId();
    const teamB = freshTeamId();
    const projectA = freshProjectId();
    const projectB = freshProjectId();
    const keyA = freshKeyId();
    const tokenA = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenAHash = hashToken(tokenA);

    await seedTeam(teamA, 'Team A');
    await seedTeam(teamB, 'Team B');
    await seedProject(teamA, projectA, 'Project A');
    await seedProject(teamB, projectB, 'Project B');

    // Key A belongs to team A, project A
    await seedApiKey({
      id: keyA,
      teamId: teamA,
      projectId: projectA,
      name: 'Team A Key',
      tokenHash: tokenAHash,
      scopes: ['read', 'events:write'],
      allProjects: false,
    });

    const ctx = await resolveTokenHash(db, tokenAHash);

    // Key A's scope is bound to team A
    expect(ctx.scope.teamId).toBe(teamA);
    if (isProjectScope(ctx.scope)) {
      expect(ctx.scope.projectId).toBe(projectA);
    }

    // Key A's scope must NOT reference team B or project B
    expect(ctx.scope.teamId).not.toBe(teamB);
    if (isProjectScope(ctx.scope)) {
      expect(ctx.scope.projectId).not.toBe(projectB);
    }

    // The team snapshot must also be team A
    expect(ctx.team.id).toBe(teamA);
  });

  // ── touchKeyLastUsed ─────────────────────────────────────────────────────

  it('updates last_used_at via touchKeyLastUsed', async () => {
    const teamId = freshTeamId();
    const projectId = freshProjectId();
    const keyId = freshKeyId();
    const token = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);

    await seedTeam(teamId);
    await seedProject(teamId, projectId);
    await seedApiKey({
      id: keyId,
      teamId,
      projectId,
      name: 'Touch Key',
      tokenHash,
      scopes: ['read'],
      allProjects: false,
    });

    // Initially last_used_at is NULL
    const before = await db.execute(
      `SELECT last_used_at FROM api_keys WHERE id = '${keyId}'`,
    );
    const beforeRows = before.rows as Array<{ last_used_at: Date | null }>;
    expect(beforeRows[0]!.last_used_at).toBeNull();

    await touchKeyLastUsed(db, keyId);

    const after = await db.execute(
      `SELECT last_used_at FROM api_keys WHERE id = '${keyId}'`,
    );
    const afterRows = after.rows as Array<{ last_used_at: Date | null }>;
    expect(afterRows[0]!.last_used_at).not.toBeNull();
  });

  // ── Scope enforcement: different project scopes are isolated ─────────────

  it('different project keys resolve to different project scopes', async () => {
    const teamId = freshTeamId();
    const projectA = freshProjectId();
    const projectB = freshProjectId();
    const keyA = freshKeyId();
    const keyB = freshKeyId();
    const tokenA = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenB = `tm_${randomUUID().replace(/-/g, '')}`;

    await seedTeam(teamId);
    await seedProject(teamId, projectA, 'Project A');
    await seedProject(teamId, projectB, 'Project B');

    await seedApiKey({
      id: keyA,
      teamId,
      projectId: projectA,
      name: 'Key A',
      tokenHash: hashToken(tokenA),
      scopes: ['read'],
      allProjects: false,
    });

    await seedApiKey({
      id: keyB,
      teamId,
      projectId: projectB,
      name: 'Key B',
      tokenHash: hashToken(tokenB),
      scopes: ['read'],
      allProjects: false,
    });

    const ctxA = await resolveTokenHash(db, hashToken(tokenA));
    const ctxB = await resolveTokenHash(db, hashToken(tokenB));

    expect(ctxA.credentialId).toBe(keyA);
    expect(ctxB.credentialId).toBe(keyB);

    if (isProjectScope(ctxA.scope) && isProjectScope(ctxB.scope)) {
      expect(ctxA.scope.projectId).toBe(projectA);
      expect(ctxB.scope.projectId).toBe(projectB);
      expect(ctxA.scope.projectId).not.toBe(ctxB.scope.projectId);
    } else {
      throw new Error('Expected both scopes to be project scopes');
    }
  });

  // ── Scope enforcement: allProjects key resolves to allProjects scope ─────

  it('all-projects key resolves to AllProjectsScope with correct team', async () => {
    const teamId = freshTeamId();
    const keyId = freshKeyId();
    const token = `tm_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);

    await seedTeam(teamId);
    await seedApiKey({
      id: keyId,
      teamId,
      name: 'Team-Wide Key',
      tokenHash,
      scopes: ['read', 'events:write'],
      allProjects: true,
    });

    const ctx = await resolveTokenHash(db, tokenHash);

    expect(isAllProjectsScope(ctx.scope)).toBe(true);
    expect(ctx.scope.teamId).toBe(teamId);
  });
});
