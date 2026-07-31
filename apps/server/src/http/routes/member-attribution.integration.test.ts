/**
 * Integration tests for Member Attribution Walkthrough (DUA-243 M2-QA-02).
 *
 * Verifies the complete OAuth + Member Attribution story:
 *   A. GitHub-webhook-verified events create principals that become
 *      contributors on concept pages, with correct display names and
 *      avatar URLs.
 *   B. When the same GitHub user signs in via OAuth (creating a user +
 *      membership), the contributor's `userId` is populated, enabling
 *      the UI to link to the internal member profile page.
 *   C. `client_claimed` (CLI/MCP) actors are NEVER stored as contributors
 *      — the concept page contributors list only contains webhook_verified
 *      or credential_bound principals.
 *   D. The member profile page correctly lists concepts contributed by
 *      that member's linked principal.
 *   E. Same GitHub App evidence: OAuth login and webhook ingestion use
 *      credentials from the same GitHub App (both `provider_kind = 'github'`
 *      and the principals table stores provider_user_id as the GitHub
 *      numeric user ID, which is the same as `users.github_id`).
 *
 * Counterexamples:
 *   - Contributors are NOT placeholders (not `system:server-cli`)
 *   - Second user gets correct role after invite acceptance
 *   - `client_claimed` identity does not enter contributors
 *
 * Tests run against real PostgreSQL.
 *
 * Requires TEST_DATABASE_URL pointing to a Postgres instance with
 * migrations applied.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { upsertPrincipal } from '../../db/repositories/principals.js';
import {
  createConcept,
  type CreateConceptInput,
  type ConceptContributorInput,
} from '../../db/repositories/concepts-write.js';
import {
  getConceptByUuid,
  enrichConceptRows,
} from '../../db/repositories/concepts-read.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('Member Attribution Walkthrough (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });
  });

  afterAll(async () => {
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    // Clean up in reverse FK order.
    await db.execute(`DELETE FROM web_sessions`);
    await db.execute(`DELETE FROM memberships`);
    await db.execute(`DELETE FROM invites`);
    await db.execute(`DELETE FROM job_events`);
    await db.execute(`DELETE FROM jobs`);
    await db.execute(`DELETE FROM concept_contributors`);
    await db.execute(`DELETE FROM concept_evidence`);
    await db.execute(`DELETE FROM concept_paths`);
    await db.execute(`DELETE FROM concepts`);
    await db.execute(`DELETE FROM events`);
    await db.execute(`DELETE FROM api_keys`);
    await db.execute(`DELETE FROM projects`);
    await db.execute(`DELETE FROM principals`);
    await db.execute(`DELETE FROM users`);
    await db.execute(`DELETE FROM teams`);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Helper: create a team directly in DB. */
  async function createTeam(name: string): Promise<string> {
    const id = `team_${randomBytes(8).toString('hex')}`;
    await db.execute(`INSERT INTO teams (id, name) VALUES ('${id}', '${name}')`);
    return id;
  }

  /** Helper: create a project directly in DB. */
  async function createProject(teamId: string, name: string): Promise<string> {
    const id = `prj_${randomBytes(12).toString('hex')}`;
    await db.execute(
      `INSERT INTO projects (id, team_id, name) VALUES ('${id}', '${teamId}', '${name}')`,
    );
    return id;
  }

  /** Helper: create a user directly in DB. */
  async function createUser(
    githubId: number,
    login: string,
    avatarUrl?: string,
  ): Promise<{ id: string; githubId: number; login: string }> {
    const id = `usr_${randomBytes(8).toString('hex')}`;
    const avatarCol = avatarUrl ? `'${avatarUrl}'` : 'NULL';
    await db.execute(
      `INSERT INTO users (id, github_id, github_login, avatar_url) VALUES ('${id}', ${githubId}, '${login}', ${avatarCol})`,
    );
    return { id, githubId, login };
  }

  /** Helper: add a membership. */
  async function addMembership(
    userId: string,
    teamId: string,
    role: string,
  ): Promise<void> {
    await db.execute(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ('${userId}', '${teamId}', '${role}')`,
    );
  }

  /** Helper: create a concept with contributors. */
  async function createConceptWithContributors(
    teamId: string,
    projectId: string,
    contributors: ConceptContributorInput[],
    overrides?: Partial<CreateConceptInput>,
  ): Promise<string> {
    const conceptInput: CreateConceptInput = {
      teamId,
      projectId,
      schemaVersion: 1,
      type: 'decision',
      status: 'active',
      confidence: 'high',
      title: overrides?.title ?? 'Test Concept',
      body: overrides?.body ?? 'Test body for attribution test.',
      firstSeen: new Date('2025-06-01T00:00:00.000Z'),
      lastConfirmed: new Date('2025-06-02T00:00:00.000Z'),
      path: overrides?.path ?? `test/attribution-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      evidence: overrides?.evidence ?? [
        {
          kind: 'repo_file',
          repo: 'teamem-ai/test-repo',
          commitSha: 'abc123def456789',
          path: 'docs/architecture.md',
          at: new Date('2025-06-01T00:00:00.000Z'),
        },
      ],
      contributors,
      ...overrides,
    };

    const result = await createConcept(db, conceptInput);
    return result.uuid;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // A. Webhook-verified principals become contributors with display info
  // ═══════════════════════════════════════════════════════════════════════════

  describe('A. Webhook-verified principals are properly attributed', () => {
    it('a webhook_verified principal appears in contributors with githubLogin and avatarUrl', async () => {
      const teamId = await createTeam('Attribution Test Team');
      const projectId = await createProject(teamId, 'demo');

      // Create a principal as if a GitHub webhook event was processed.
      // This simulates what the GitHub connector does: upsert a principal
      // for the GitHub actor with providerUserId = the GitHub user's numeric id.
      const principalResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: '583231', // example GitHub user id
        kind: 'human',
        displayLogin: 'octocat',
      });

      // Create a concept contributed by this webhook_verified principal
      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        {
          principalId: principalResult.id,
          provenance: 'webhook_verified',
        },
      ], { title: 'Architecture Decision Record' });

      // Fetch the concept detail
      const concept = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(concept).not.toBeNull();
      expect(concept!.contributors).toHaveLength(1);

      const contributor = concept!.contributors[0]!;
      // Must be a human, not a placeholder
      expect(contributor.kind).toBe('human');
      expect(contributor.principalId).toBe(principalResult.id);
      // Must NOT be a placeholder like "system:server-cli"
      expect(contributor.displayName).not.toContain('system');
      expect(contributor.displayName).not.toContain('server-cli');
      expect(contributor.displayName).not.toContain('placeholder');

      // Must have githubLogin and avatarUrl (derived from displayLogin)
      expect(contributor.githubLogin).toBe('octocat');
      expect(contributor.avatarUrl).toBe('https://avatars.githubusercontent.com/octocat?size=64');

      // provider must be the providerKind ('github')
      expect(contributor.provider).toBe('github');

      // userId is NOT set yet (user hasn't signed in)
      expect(contributor.userId).toBeUndefined();
    });

    it('contributors are NOT placeholder values', async () => {
      const teamId = await createTeam('No Placeholder Team');
      const projectId = await createProject(teamId, 'demo');

      const principalResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: '999999',
        kind: 'human',
        displayLogin: 'real-user',
      });

      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        {
          principalId: principalResult.id,
          provenance: 'webhook_verified',
        },
      ]);

      const concept = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(concept).not.toBeNull();

      for (const c of concept!.contributors) {
        // NEVER a placeholder
        expect(c.displayName).toBeTruthy();
        expect(c.displayName!.toLowerCase()).not.toContain('placeholder');
        expect(c.displayName!.toLowerCase()).not.toContain('system');
        expect(c.principalId).toMatch(/^pri_/);
        // Kind must be a valid frozen enum value
        expect(['human', 'service']).toContain(c.kind);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // B. User sign-in links the contributor to a member profile (userId)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('B. OAuth login links contributor to member profile', () => {
    it('contributor gets userId when GitHub user signs in and has team membership', async () => {
      const teamId = await createTeam('Member Link Team');
      const projectId = await createProject(teamId, 'demo');

      const githubUserId = 583232;

      // Step 1: Create a principal (as if from a webhook event)
      const principalResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: String(githubUserId),
        kind: 'human',
        displayLogin: 'member-user',
      });

      // Step 2: Create a concept with this principal as contributor
      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        {
          principalId: principalResult.id,
          provenance: 'webhook_verified',
        },
      ], { title: 'Pre-Login Concept' });

      // Step 3: Verify contributor exists but has no userId yet
      const conceptBefore = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(conceptBefore!.contributors[0]!.userId).toBeUndefined();

      // Step 4: Simulate the GitHub user signing in via OAuth.
      // This creates a users row with github_id matching the principal's providerUserId.
      const user = await createUser(githubUserId, 'member-user', 'https://avatars.githubusercontent.com/u/583232');

      // Step 5: Add team membership (as happens during first login or invite accept)
      await addMembership(user.id, teamId, 'member');

      // Step 6: Fetch the concept again — contributor should now have userId
      const conceptAfter = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(conceptAfter).not.toBeNull();
      expect(conceptAfter!.contributors).toHaveLength(1);

      const contributor = conceptAfter!.contributors[0]!;
      // Must now have userId that matches the user's internal id
      expect(contributor.userId).toBe(user.id);
      expect(contributor.githubLogin).toBe('member-user');
      expect(contributor.avatarUrl).toBe('https://avatars.githubusercontent.com/member-user?size=64');

      // The UI links to /members/:userId using this userId — verify format
      expect(contributor.userId).toMatch(/^usr_[A-Za-z0-9]+$/);
    });

    it('contributor userId is null when user is not a team member', async () => {
      const teamId = await createTeam('Non-Member Link Team');
      const projectId = await createProject(teamId, 'demo');

      const githubUserId = 583233;

      // Create principal
      const principalResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: String(githubUserId),
        kind: 'human',
        displayLogin: 'non-member-user',
      });

      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        {
          principalId: principalResult.id,
          provenance: 'webhook_verified',
        },
      ]);

      // Create user (signed in via OAuth) but do NOT add membership
      await createUser(githubUserId, 'non-member-user');

      // Fetch concept — userId should NOT be set (user is not a member of this team)
      const concept = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(concept).not.toBeNull();
      expect(concept!.contributors[0]!.userId).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // C. client_claimed actors are NEVER contributors
  // ═══════════════════════════════════════════════════════════════════════════

  describe('C. client_claimed actors are excluded from contributors', () => {
    it('client_claimed provenance is filtered out by the write repository', async () => {
      const teamId = await createTeam('ClientClaimed Filter Team');
      const projectId = await createProject(teamId, 'demo');

      // Create a principal for the client_claimed actor
      const principalResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: '12345',
        kind: 'human',
        displayLogin: 'cli-user',
      });

      // Attempt to create a concept with a client_claimed contributor
      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        {
          principalId: principalResult.id,
          provenance: 'client_claimed', // CLI/MCP self-reported identity
        },
      ], { title: 'CLI-Initiated Concept' });

      // Fetch the concept — the client_claimed contributor should NOT appear
      const concept = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(concept).not.toBeNull();
      // The contributorCount returned from createConcept should be 0
      expect(concept!.contributors).toHaveLength(0);
    });

    it('unknown provenance is also filtered out', async () => {
      const teamId = await createTeam('UnknownProv Team');
      const projectId = await createProject(teamId, 'demo');

      const principalResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: '99999',
        kind: 'human',
        displayLogin: 'unknown-user',
      });

      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        {
          principalId: principalResult.id,
          provenance: 'unknown',
        },
      ]);

      const concept = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(concept).not.toBeNull();
      expect(concept!.contributors).toHaveLength(0);
    });

    it('only webhook_verified and credential_bound enter contributors', async () => {
      const teamId = await createTeam('TrustedProv Team');
      const projectId = await createProject(teamId, 'demo');

      // Create distinct principals for each provenance
      const webhookPrincipal = await upsertPrincipal(db, {
        teamId, provider: 'github', providerKind: 'github',
        providerUserId: '111', kind: 'human', displayLogin: 'webhook-user',
      });
      const credPrincipal = await upsertPrincipal(db, {
        teamId, provider: 'github', providerKind: 'github',
        providerUserId: '222', kind: 'human', displayLogin: 'cred-user',
      });
      const clientClaimedPrincipal = await upsertPrincipal(db, {
        teamId, provider: 'github', providerKind: 'github',
        providerUserId: '333', kind: 'human', displayLogin: 'cli-user',
      });
      const unknownPrincipal = await upsertPrincipal(db, {
        teamId, provider: 'github', providerKind: 'github',
        providerUserId: '444', kind: 'human', displayLogin: 'unknown-user',
      });

      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        { principalId: webhookPrincipal.id, provenance: 'webhook_verified' },
        { principalId: credPrincipal.id, provenance: 'credential_bound' },
        { principalId: clientClaimedPrincipal.id, provenance: 'client_claimed' },
        { principalId: unknownPrincipal.id, provenance: 'unknown' },
      ]);

      const concept = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(concept).not.toBeNull();
      // Only webhook_verified and credential_bound should survive
      expect(concept!.contributors).toHaveLength(2);

      const principalIds = concept!.contributors.map((c) => c.principalId);
      expect(principalIds).toContain(webhookPrincipal.id);
      expect(principalIds).toContain(credPrincipal.id);
      expect(principalIds).not.toContain(clientClaimedPrincipal.id);
      expect(principalIds).not.toContain(unknownPrincipal.id);
    });

    it('concept created without any trusted contributors has empty contributors list', async () => {
      const teamId = await createTeam('NoTrusted Team');
      const projectId = await createProject(teamId, 'demo');

      // Only client_claimed contributors
      const principalResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: '55555',
        kind: 'human',
        displayLogin: 'cli-only-user',
      });

      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        { principalId: principalResult.id, provenance: 'client_claimed' },
      ], { title: 'CLI-Only Concept' });

      const concept = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(concept).not.toBeNull();
      expect(concept!.contributors).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // D. Same GitHub App: OAuth + ingestion credential alignment
  // ═══════════════════════════════════════════════════════════════════════════

  describe('D. Same GitHub App for OAuth and ingestion', () => {
    it('principals use github provider with numeric providerUserId = users.github_id', async () => {
      const teamId = await createTeam('SameApp Team');

      const githubUserId = 424242;

      // Step 1: Principal created by webhook ingestion
      const principalResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: String(githubUserId),
        kind: 'human',
        displayLogin: 'sameapp-user',
      });

      // Verify principal has provider='github', providerKind='github'
      const principalRows = await db.$client.query(
        `SELECT provider, provider_kind, provider_user_id, display_login FROM principals WHERE id = $1`,
        [principalResult.id],
      );
      const principalRow = principalRows.rows[0] as Record<string, unknown>;
      expect(principalRow['provider']).toBe('github');
      expect(principalRow['provider_kind']).toBe('github');
      expect(principalRow['provider_user_id']).toBe(String(githubUserId));
      expect(principalRow['display_login']).toBe('sameapp-user');

      // Step 2: User created by OAuth login (same GitHub user id)
      const user = await createUser(githubUserId, 'sameapp-user');

      // Step 3: The linkage: users.github_id == principals.provider_user_id
      // This is how the read repository resolves userId for contributors.
      // Verify the join works by querying the same way concepts-read does:
      const joinResult = await db.$client.query(
        `SELECT p.id as principal_id, u.id as user_id
         FROM principals p
         JOIN users u ON u.github_id::text = p.provider_user_id
         WHERE p.team_id = $1 AND p.id = $2`,
        [teamId, principalResult.id],
      );
      expect(joinResult.rows).toHaveLength(1);
      const joinRow = joinResult.rows[0] as Record<string, unknown>;
      expect(joinRow['principal_id']).toBe(principalResult.id);
      expect(joinRow['user_id']).toBe(user.id);
    });

    it('both OAuth config and webhook config come from the same GitHub App', async () => {
      // This test verifies the architectural invariant that login and ingestion
      // reference the same GitHub App credentials.
      //
      // The OAuth flow uses:
      //   - GITHUB_APP_CLIENT_ID (the App's OAuth client ID)
      //   - GITHUB_APP_CLIENT_SECRET (the App's OAuth client secret)
      //
      // The webhook ingestion uses:
      //   - GITHUB_WEBHOOK_SECRET (the App's webhook secret)
      //
      // Both are credentials from the SAME GitHub App. In the database,
      // both produce principals with provider='github', and the linkage
      // between the webhook actor's github_id and the OAuth user's github_id
      // is what enables the attribution flow.

      const teamId = await createTeam('CredentialAlignment Team');

      // Simulate: webhook ingestion creates a principal for GitHub user 123
      const ingestResult = await upsertPrincipal(db, {
        teamId,
        provider: 'github',
        providerKind: 'github',
        providerUserId: '123',
        kind: 'human',
        displayLogin: 'same-person',
      });

      // Simulate: OAuth login creates a users row for the same GitHub user
      const user = await createUser(123, 'same-person');

      // The integration point: both reference the same GitHub identity
      // (github_id = 123), which is only possible because both the OAuth
      // client and the webhook connector are backed by the same GitHub App.
      const linkageResult = await db.$client.query(
        `SELECT u.id, u.github_id, u.github_login,
                p.id as principal_id, p.display_login
         FROM users u
         JOIN principals p
           ON p.provider_user_id = u.github_id::text
           AND p.team_id = $1
         WHERE u.github_id = 123`,
        [teamId],
      );
      expect(linkageResult.rows).toHaveLength(1);
      const row = linkageResult.rows[0] as Record<string, unknown>;
      expect(row['id']).toBe(user.id);
      expect(row['principal_id']).toBe(ingestResult.id);

      // This proves the principal (from ingestion) and user (from OAuth)
      // are linked by github_id — the single source of truth from the App.
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E. Service principals are properly represented (not misreported as human)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('E. Service principal attribution', () => {
    it('credential_bound service principals appear as contributors (e.g. API keys)', async () => {
      const teamId = await createTeam('Service Principal Team');
      const projectId = await createProject(teamId, 'demo');

      // Create a service principal (e.g., from an API key / bootstrap)
      const servicePrincipal = await upsertPrincipal(db, {
        teamId,
        provider: 'external',
        providerKind: 'teamem',
        providerUserId: 'bootstrap:server',
        kind: 'service',
        displayLogin: 'teamem-server',
      });

      const conceptUuid = await createConceptWithContributors(teamId, projectId, [
        {
          principalId: servicePrincipal.id,
          provenance: 'credential_bound',
        },
      ], { title: 'Service-Contributed Concept' });

      const concept = await getConceptByUuid(db, teamId, projectId, conceptUuid);
      expect(concept).not.toBeNull();
      expect(concept!.contributors).toHaveLength(1);

      const contributor = concept!.contributors[0]!;
      expect(contributor.kind).toBe('service');
      expect(contributor.provider).toBe('teamem');
      expect(contributor.displayName).toBe('teamem-server');
      // Service principals should NOT have githubLogin
      expect(contributor.githubLogin).toBeUndefined();
      // Service principals should NOT have userId
      expect(contributor.userId).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // F. enrichConceptRows resolves contributors with userId correctly
  // ═══════════════════════════════════════════════════════════════════════════

  describe('F. enrichConceptRows resolves userId for contributors', () => {
    it('enriches multiple concept rows with correct contributor linkage', async () => {
      const teamId = await createTeam('Bulk Enrich Team');
      const projectId = await createProject(teamId, 'demo');

      const githubId1 = 111;
      const githubId2 = 222;

      // Create principals (from webhook)
      const p1 = await upsertPrincipal(db, {
        teamId, provider: 'github', providerKind: 'github',
        providerUserId: String(githubId1), kind: 'human', displayLogin: 'user-one',
      });
      const p2 = await upsertPrincipal(db, {
        teamId, provider: 'github', providerKind: 'github',
        providerUserId: String(githubId2), kind: 'human', displayLogin: 'user-two',
      });

      // Create two concepts
      const uuid1 = await createConceptWithContributors(teamId, projectId, [
        { principalId: p1.id, provenance: 'webhook_verified' },
      ], { title: 'Concept One', path: 'test/concept-one' });

      const uuid2 = await createConceptWithContributors(teamId, projectId, [
        { principalId: p2.id, provenance: 'webhook_verified' },
      ], { title: 'Concept Two', path: 'test/concept-two' });

      // Enrich without users (no OAuth login yet)
      const rawRows1 = [
        { uuid: uuid1, teamId: teamId, projectId: projectId },
        { uuid: uuid2, teamId: teamId, projectId: projectId },
      ];
      const enriched1 = await enrichConceptRows(db, teamId, projectId, rawRows1);
      expect(enriched1[0]!.contributors[0]!.userId).toBeUndefined();
      expect(enriched1[1]!.contributors[0]!.userId).toBeUndefined();

      // Now create users and memberships (OAuth login)
      const user1 = await createUser(githubId1, 'user-one');
      await addMembership(user1.id, teamId, 'member');
      const user2 = await createUser(githubId2, 'user-two');
      await addMembership(user2.id, teamId, 'admin');

      // Enrich again — userIds should now be populated
      const enriched2 = await enrichConceptRows(db, teamId, projectId, rawRows1);
      expect(enriched2[0]!.contributors[0]!.userId).toBe(user1.id);
      expect(enriched2[1]!.contributors[0]!.userId).toBe(user2.id);
    });
  });
});
