/**
 * GitHub issue webhook normalizer — real-Postgres integration test (DUA-145).
 *
 * Closes the loop, end-to-end, at the persistence boundary: a
 * `NormalizedEvent` produced by `normalizeGithubIssueEvent` (the code under
 * test in `issue.unit.test.ts`) is fed through the real
 * `persistNormalizedEvent` storage layer and lands in `events`/`principals`
 * with the correct built-in `github` channel, `github_issue` kind, and
 * *already-redacted* payload. No mock database — honestly skipped when
 * `TEST_DATABASE_URL` is absent (red line 11).
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   docker cp apps/server/drizzle/0000_*.sql teamem-postgres-1:/tmp/0.sql && \
 *   docker exec teamem-postgres-1 psql -U teamem -d teamem -f /tmp/0.sql
 *   (likewise for 0001)
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem \
 *     pnpm --filter @teamem/server exec vitest run \
 *       --config vitest.integration.config.ts issue.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../../db/client.js';
import {
  persistNormalizedEvent,
  type ConnectorScope,
} from '../connector-storage.js';
import { normalizeGithubIssueEvent } from './issue.js';

const url = process.env['TEST_DATABASE_URL'];
const describeDb = describe.skipIf(!url);

describeDb('github issues normalizer → persistNormalizedEvent (live Postgres)', () => {
  let db: AppDb;
  // Use a UNIQUE team/project id namespace so this file never races with
  // the existing connector-storage integration suite (which shares
  // 'team_conn'/'prj_conn'). The pre-existing api-keys suite still deletes
  // ALL teams at setup, so we re-seed inside beforeEach to survive that.
  const teamId = 'team_gh_issue';
  const projectId = 'prj_gh_issue';
  const scope: ConnectorScope = { teamId, projectId };

  async function seedTenant() {
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${teamId}', 'GH Issue')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO projects (id, team_id, name) VALUES ('${projectId}', '${teamId}', 'GH Issue Project')
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  beforeAll(async () => {
    db = createDb(url!);
    await seedTenant();
  });

  afterAll(async () => {
    if (db) {
      await db.execute(`
        DELETE FROM events WHERE project_id = '${projectId}';
        DELETE FROM principals WHERE team_id = '${teamId}';
        DELETE FROM projects WHERE id = '${projectId}';
        DELETE FROM teams WHERE id = '${teamId}';
      `);
      await db.$client.end();
    }
  });

  beforeEach(async () => {
    // Re-seed in case another concurrent integration file wiped our teams.
    await seedTenant();
    await db.execute(`
      DELETE FROM events WHERE project_id = '${projectId}';
      DELETE FROM principals WHERE team_id = '${teamId}';
    `);
  });

  // One real GitHub-shaped "issues" webhook payload — enough to land every
  // consumed field through persistence.
  const openedIssuePayload = (overrides?: Record<string, unknown>) => ({
    action: 'opened',
    issue: {
      id: 1_494_193_256_4,
      number: 7,
      node_id: 'I_kwDOABcEdeABCDE',
      title: 'Investigate <private>secret S3://bucket-x</private> boot',
      body: '## Context\n\nNeed <private>hunter2</private> token.',
      state: 'open',
      labels: [{ id: 1, name: 'bug' }, { id: 2, name: '<private>internal</private>-perf' }],
      html_url: 'https://github.com/octocat/Hello-World/issues/7',
      created_at: '2026-07-17T12:00:00Z',
      updated_at: '2026-07-17T12:00:00Z',
    },
    repository: {
      full_name: 'octocat/Hello-World',
      name: 'Hello-World',
      owner: { login: 'octocat' },
    },
    sender: { login: 'octocat', id: 583231, type: 'User' },
    ...overrides,
  });

  it('success: a parsed issue event persists on the github builtin channel + github_issue kind with a redacted payload', async () => {
    const result = normalizeGithubIssueEvent({
      payload: openedIssuePayload(),
      deliveryId: 'del-gh-issue-1',
      webhookVerified: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const persisted = await persistNormalizedEvent(db, scope, result.event);

    expect(persisted.duplicate).toBe(false);
    expect(persisted.channel).toBe('github');
    expect(persisted.connectorKind).toBe('github');
    expect(persisted.principalId).not.toBeNull();

    const { rows } = await db.execute(
      `SELECT channel, kind, connector_kind, delivery_id, item_key, external_id, url,
              payload, source_event, source_action
       FROM events WHERE id = '${persisted.eventId}'`,
    );
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      channel: 'github',
      kind: 'github_issue',
      connector_kind: 'github',
      delivery_id: 'del-gh-issue-1',
      item_key: '7',
      external_id: 'octocat/Hello-World#7',
      url: 'https://github.com/octocat/Hello-World/issues/7',
      source_event: 'issues',
      source_action: 'opened',
    });

    // §5.3 redaction is enforced at persistence: no <private> survives in
    // the stored payload or its body/labels names.
    const payloadStr = JSON.stringify(row!['payload']);
    expect(payloadStr).not.toContain('<private>');
    expect(payloadStr).not.toContain('hunter2');
    expect(payloadStr).not.toContain('secret S3');
    expect(payloadStr).not.toContain('internal');
  });

  it('idempotent replay of the same issue delivery returns the original event, no new row (N1)', async () => {
    const first = normalizeGithubIssueEvent({
      payload: openedIssuePayload({ action: 'opened' }),
      deliveryId: 'del-gh-issue-2',
      webhookVerified: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const a = await persistNormalizedEvent(db, scope, first.event);
    const b = await persistNormalizedEvent(db, scope, first.event);

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.eventId).toBe(a.eventId);

    const { rows } = await db.execute(
      `SELECT count(*)::int AS n FROM events WHERE delivery_id = 'del-gh-issue-2'`,
    );
    expect(rows[0]).toMatchObject({ n: 1 });
  });

  it('two distinct issue deliveries (opened + edited) sharing externalId/itemKey persist as distinct events', async () => {
    const opened = normalizeGithubIssueEvent({
      payload: openedIssuePayload({ action: 'opened' }),
      deliveryId: 'del-gh-issue-opened',
      webhookVerified: true,
    });
    const editedPayload = openedIssuePayload({
      action: 'edited',
      issue: {
        ...openedIssuePayload().issue,
        title: 'Investigate boot (edited)',
        updated_at: '2026-07-17T14:00:00Z',
      },
    });
    const edited = normalizeGithubIssueEvent({
      payload: editedPayload,
      deliveryId: 'del-gh-issue-edited',
      webhookVerified: true,
    });
    expect(opened.ok && edited.ok).toBe(true);
    if (!opened.ok || !edited.ok) return;

    const a = await persistNormalizedEvent(db, scope, opened.event);
    const b = await persistNormalizedEvent(db, scope, edited.event);

    expect(a.eventId).not.toBe(b.eventId);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);

    const { rows } = await db.execute(
      `SELECT delivery_id, source_action FROM events
       WHERE delivery_id IN ('del-gh-issue-opened','del-gh-issue-edited')
       ORDER BY delivery_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r as Record<string, unknown>)['source_action']).sort())
      .toEqual(['edited', 'opened']);
  });

  it('an actor-less issue delivery still persists with actor=null and actor_principal_id=NULL (N2: never fabricated)', async () => {
    const result = normalizeGithubIssueEvent({
      payload: openedIssuePayload({ sender: undefined }),
      deliveryId: 'del-gh-issue-noactor',
      webhookVerified: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const persisted = await persistNormalizedEvent(db, scope, result.event);
    expect(persisted.principalId).toBeNull();

    const { rows } = await db.execute(
      `SELECT actor, actor_principal_id FROM events WHERE id = '${persisted.eventId}'`,
    );
    const actorRow = rows[0];
    expect(actorRow).toBeDefined();
    expect(actorRow!['actor']).toBeNull();
    expect(actorRow!['actor_principal_id']).toBeNull();
  });
});