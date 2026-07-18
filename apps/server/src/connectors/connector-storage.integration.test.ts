/**
 * Connector persistence seam — real-Postgres integration tests (DUA-129).
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres with migrations
 * 0000+0001 applied; honestly skipped otherwise — no mocked database, per
 * project red line.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   psql < apps/server/drizzle/0000_*.sql
 *   psql < apps/server/drizzle/0001_*.sql
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type AppDb } from '../db/client.js';
import {
  InvalidNormalizedEventError,
  persistNormalizedEvent,
  resolveOrCreatePrincipal,
  type ConnectorScope,
} from './connector-storage.js';
import type { NormalizedEvent } from './registry.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('connector-storage (generic persistence seam, live Postgres)', () => {
  let db: AppDb;
  const scope: ConnectorScope = { teamId: 'team_conn', projectId: 'prj_conn' };

  beforeAll(async () => {
    db = createDb(url!);
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('team_conn', 'Conn')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO projects (id, team_id, name) VALUES ('prj_conn', 'team_conn', 'Conn Project')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    await db.execute(`
      DELETE FROM events WHERE project_id = 'prj_conn';
      DELETE FROM principals WHERE team_id = 'team_conn';
      DELETE FROM projects WHERE id = 'prj_conn';
      DELETE FROM teams WHERE id = 'team_conn';
    `);
  });

  beforeEach(async () => {
    await db.execute(`
      DELETE FROM events WHERE project_id = 'prj_conn';
      DELETE FROM principals WHERE team_id = 'team_conn';
    `);
  });

  const slackLikeEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    connectorKind: 'slack',
    eventKind: 'message.channels',
    deliveryId: 'Ev123',
    itemKey: 'root',
    externalId: 'C042/p1746992',
    actor: {
      kind: 'human',
      provider: 'slack',
      providerUserId: 'U123',
      displayLogin: 'alice',
    },
    actorProvenance: 'webhook_verified',
    occurredAt: '2026-07-17T00:00:00.000Z',
    occurredAtProvenance: 'provider',
    payload: { text: 'we decided to use Postgres' },
    ...overrides,
  });

  const gmailLikeEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    connectorKind: 'gmail',
    eventKind: 'message.new',
    deliveryId: 'Ev123', // SAME delivery id as the slack-like fixture above
    itemKey: 'root', // SAME item key — the required non-collision counterexample
    externalId: 'thread-99/msg-1',
    actor: {
      kind: 'human',
      provider: 'gmail',
      providerUserId: 'U123', // same providerUserId as slack fixture, different provider
      displayLogin: 'alice@example.com',
    },
    actorProvenance: 'client_claimed',
    occurredAt: '2026-07-17T00:05:00.000Z',
    occurredAtProvenance: 'client',
    payload: { subject: 'we decided to use Postgres' },
    ...overrides,
  });

  it('success: persists a slack-like event on the generic external channel with connector identity preserved', async () => {
    const result = await persistNormalizedEvent(db, scope, slackLikeEvent());

    expect(result.channel).toBe('external');
    expect(result.connectorKind).toBe('slack');
    expect(result.principalId).not.toBeNull();

    const { rows: eventRows } = await db.execute(
      `SELECT channel, kind, connector_kind, source_event, actor_principal_id
       FROM events WHERE id = '${result.eventId}'`,
    );
    expect(eventRows[0]).toMatchObject({
      channel: 'external',
      kind: 'external_event',
      connector_kind: 'slack',
      source_event: 'message.channels',
    });

    const { rows: principalRows } = await db.execute(
      `SELECT provider, provider_kind, provider_user_id FROM principals WHERE id = '${result.principalId}'`,
    );
    expect(principalRows[0]).toMatchObject({
      provider: 'external',
      provider_kind: 'slack',
      provider_user_id: 'U123',
    });
  });

  it('success: a built-in connector keeps its own channel/kind (not masqueraded as external)', async () => {
    const result = await persistNormalizedEvent(db, scope, {
      connectorKind: 'github',
      eventKind: 'github_commit',
      deliveryId: 'gh-delivery-1',
      itemKey: 'sha-abc',
      externalId: 'org/repo@abc',
      actor: null,
      actorProvenance: 'unknown',
      occurredAt: '2026-07-17T00:00:00.000Z',
      occurredAtProvenance: 'server',
      payload: {},
    });

    expect(result.channel).toBe('github');
    expect(result.connectorKind).toBe('github');
    expect(result.principalId).toBeNull();
  });

  it('failure: a built-in connector emitting an unknown eventKind is rejected, not silently external', async () => {
    await expect(
      persistNormalizedEvent(db, scope, {
        connectorKind: 'github',
        eventKind: 'not_a_real_source_kind',
        deliveryId: 'gh-delivery-2',
        itemKey: 'root',
        externalId: 'org/repo#1',
        actor: null,
        actorProvenance: 'unknown',
        occurredAt: '2026-07-17T00:00:00.000Z',
        occurredAtProvenance: 'server',
        payload: {},
      }),
    ).rejects.toThrow(InvalidNormalizedEventError);
  });

  it('failure: replaying the same connector/delivery/item collides (idempotency preserved)', async () => {
    await persistNormalizedEvent(db, scope, slackLikeEvent());
    await expect(persistNormalizedEvent(db, scope, slackLikeEvent())).rejects.toMatchObject({
      cause: { constraint: 'events_idempotency_uq' },
    });
  });

  it('REQUIRED counterexample: a slack-like and a gmail-like event sharing delivery/item id do not collide or merge identity', async () => {
    const slackResult = await persistNormalizedEvent(db, scope, slackLikeEvent());
    const gmailResult = await persistNormalizedEvent(db, scope, gmailLikeEvent());

    // Both persisted as distinct rows — no idempotency collision even though
    // deliveryId/itemKey are identical, because connectorKind differs.
    expect(slackResult.eventId).not.toBe(gmailResult.eventId);
    expect(slackResult.connectorKind).toBe('slack');
    expect(gmailResult.connectorKind).toBe('gmail');

    // Neither masquerades as a built-in github/cli/mcp channel.
    expect(slackResult.channel).toBe('external');
    expect(gmailResult.channel).toBe('external');

    const { rows } = await db.execute(
      `SELECT id, connector_kind, delivery_id, item_key FROM events
       WHERE delivery_id = 'Ev123' AND item_key = 'root' AND project_id = 'prj_conn'
       ORDER BY connector_kind`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['connector_kind'])).toEqual(['gmail', 'slack']);

    // Distinct principals too — same providerUserId 'U123', different
    // provider — must NOT resolve to the same principal row.
    expect(slackResult.principalId).not.toBe(gmailResult.principalId);
    const { rows: principals } = await db.execute(
      `SELECT provider_kind, provider_user_id FROM principals
       WHERE team_id = 'team_conn' AND provider_user_id = 'U123'
       ORDER BY provider_kind`,
    );
    expect(principals).toHaveLength(2);
    expect(principals.map((p) => p['provider_kind'])).toEqual(['gmail', 'slack']);
  });

  it('principal resolution is idempotent per (team, provider, providerKind, providerUserId)', async () => {
    const actor = {
      kind: 'human' as const,
      provider: 'slack',
      providerUserId: 'U999',
      displayLogin: 'bob',
    };
    const first = await resolveOrCreatePrincipal(db, scope, actor);
    const second = await resolveOrCreatePrincipal(db, scope, actor);
    expect(first).toBe(second);

    const { rows } = await db.execute(
      `SELECT count(*)::int AS n FROM principals WHERE team_id = 'team_conn' AND provider_user_id = 'U999'`,
    );
    expect(rows[0]).toMatchObject({ n: 1 });
  });

  it('sanity: fixture ids are actually shared (guards against a rotted counterexample)', () => {
    const a = slackLikeEvent();
    const b = gmailLikeEvent();
    expect(a.deliveryId).toBe(b.deliveryId);
    expect(a.itemKey).toBe(b.itemKey);
    expect(a.connectorKind).not.toBe(b.connectorKind);
    expect(randomUUID()).not.toBe(randomUUID()); // sanity on the test's own tooling
  });
});
