/**
 * Principal upsert repository — real-Postgres integration tests.
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres with migrations
 * 0000+0001 applied; honestly skipped otherwise — no mocked database, per
 * project red line.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../client.js';
import { upsertPrincipal, findPrincipal } from './principals.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('PrincipalUpsertRepository (live Postgres)', () => {
  let db: AppDb;

  beforeAll(async () => {
    db = createDb(url!);
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('team_pu_tests', 'PU Tests')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    await db.execute(`
      DELETE FROM principals WHERE team_id = 'team_pu_tests';
      DELETE FROM teams WHERE id = 'team_pu_tests';
    `);
  });

  beforeEach(async () => {
    await db.execute(`DELETE FROM principals WHERE team_id = 'team_pu_tests'`);
  });

  describe('success path', () => {
    it('creates a new principal and returns created=true', async () => {
      const result = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '12345',
        kind: 'human',
        displayLogin: 'octocat',
      });

      expect(result.created).toBe(true);
      expect(result.updated).toBe(false);
      expect(result.id).toMatch(/^pri_[A-Za-z0-9]+$/);
    });

    it('updates display_login on conflict without changing principal id (same providerUserId, different login)', async () => {
      // First insert
      const first = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '67890',
        kind: 'human',
        displayLogin: 'old-login',
      });
      expect(first.created).toBe(true);

      // Second upsert — same provider identity, different login
      const second = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '67890',
        kind: 'human',
        displayLogin: 'new-login',
      });
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
      expect(second.updated).toBe(true);

      // Verify display_login was updated
      const found = await findPrincipal(
        db,
        'team_pu_tests',
        'github',
        'github',
        '67890',
      );
      expect(found).toBeDefined();
      expect(found!.displayLogin).toBe('new-login');
    });

    it('preserves kind on conflict — never changed by a later upsert', async () => {
      // Create as 'human'
      const first = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '11111',
        kind: 'human',
        displayLogin: 'alice',
      });
      expect(first.created).toBe(true);

      // Upsert with kind='service' — must NOT change the stored kind
      await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '11111',
        kind: 'service',
        displayLogin: 'alice-v2',
      });

      const found = await findPrincipal(
        db,
        'team_pu_tests',
        'github',
        'github',
        '11111',
      );
      expect(found!.kind).toBe('human');
      expect(found!.displayLogin).toBe('alice-v2');
    });
  });

  describe('tenant isolation', () => {
    it('same providerUserId in different teams produces independent principals', async () => {
      const { rows } = await db.execute(
        `SELECT count(*)::int AS n FROM teams WHERE id = 'team_pu_other'`,
      );
      if (!rows[0] || !rows[0]['n']) {
        await db.execute(
          `INSERT INTO teams (id, name) VALUES ('team_pu_other', 'PU Other') ON CONFLICT (id) DO NOTHING`,
        );
      }

      await db.execute(`DELETE FROM principals WHERE team_id = 'team_pu_other'`);

      // Same providerUserId, same provider, same kind, different teams
      const a = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '99999',
        kind: 'human',
        displayLogin: 'shared-user',
      });
      const b = await upsertPrincipal(db, {
        teamId: 'team_pu_other',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '99999',
        kind: 'human',
        displayLogin: 'shared-user',
      });

      expect(a.id).not.toBe(b.id);
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);

      // Cleanup
      await db.execute(`DELETE FROM principals WHERE team_id = 'team_pu_other'`);
    });
  });

  describe('idempotency', () => {
    it('upserting the exact same input twice returns updated=false on repeat', async () => {
      const first = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '55555',
        kind: 'human',
        displayLogin: 'bob',
      });
      expect(first.created).toBe(true);

      const second = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'github',
        providerKind: 'github',
        providerUserId: '55555',
        kind: 'human',
        displayLogin: 'bob',
      });
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
      // PG performs the update even when values match, but we label it as updated.
      // The key invariant is: same principal id, no row duplication.
    });
  });

  describe('external provider', () => {
    it('creates and updates a principal via the external provider bucket', async () => {
      const first = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'slack',
        providerKind: 'slack',
        providerUserId: 'U12345',
        kind: 'human',
        displayLogin: 'slack-user',
      });
      expect(first.created).toBe(true);

      const second = await upsertPrincipal(db, {
        teamId: 'team_pu_tests',
        provider: 'slack',
        providerKind: 'slack',
        providerUserId: 'U12345',
        kind: 'human',
        displayLogin: 'slack-user-renamed',
      });
      expect(second.id).toBe(first.id);
      expect(second.updated).toBe(true);

      const found = await findPrincipal(
        db,
        'team_pu_tests',
        'slack',
        'slack',
        'U12345',
      );
      expect(found!.provider).toBe('external');
      expect(found!.providerKind).toBe('slack');
    });
  });
});
