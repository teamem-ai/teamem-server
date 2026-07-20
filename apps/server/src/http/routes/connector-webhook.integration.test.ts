/**
 * Connector webhook route — real-Postgres integration tests (M0-GH-08 / DUA-148).
 *
 * Verifies the full GitHub webhook pipeline against real PostgreSQL:
 *
 *   1. Signature-verified fixture → one event, one principal, one job.
 *   2. Replay with same bytes/delivery ID → no duplicate rows/jobs.
 *   3. Wrong signature → 401, nothing persisted.
 *   4. Unsupported event type → 200 "accepted/ignored", no rows/jobs.
 *   5. Signature is case-insensitive header lookup.
 *
 * Runs only when TEST_DATABASE_URL is set; honestly skipped otherwise.
 *
 *   POSTGRES_PASSWORD=x docker compose up -d postgres
 *   psql < apps/server/drizzle/0000_*.sql
 *   psql < apps/server/drizzle/0001_*.sql
 *   TEST_DATABASE_URL=postgres://teamem:x@localhost:5432/teamem pnpm test
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../../app.js';
import { createDb, type AppDb } from '../../db/client.js';
import {
  connectDatabase,
  closeDatabase,
  type Pool,
} from '../../test/database.js';
import { registerConnector, resetConnectors } from '../../connectors/registry.js';
import { GitHubConnector } from '../../connectors/github/connector.js';

const url = process.env['TEST_DATABASE_URL'];

// ── Synthetic webhook fixtures ──────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret-gh08';
const SYNTHETIC_PROJECT = 'prj_gh08test001';
const SYNTHETIC_TEAM = 'team_gh08test001';
const SYNTHETIC_DELIVERY_ID = '11111111-1111-1111-1111-111111111111';

/** Sign the body bytes with HMAC-SHA256. */
function sign(body: string | Buffer, secret = WEBHOOK_SECRET): string {
  const mac = createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return `sha256=${mac}`;
}

/** "issues" webhook — opened event (synthetic, no real data). */
const issuesOpenedFixture = {
  action: 'opened',
  issue: {
    id: 1001,
    number: 42,
    node_id: 'I_kwTEST0001',
    title: 'Consider using Postgres for the write path',
    body: 'We should evaluate Postgres vs other options. <private>internal: budget is $5k</private>',
    state: 'open' as const,
    labels: [{ id: 1, name: 'enhancement' }],
    html_url: 'https://github.com/synth-org/synth-repo/issues/42',
    created_at: '2026-07-17T10:00:00Z',
    updated_at: '2026-07-17T10:00:00Z',
  },
  repository: {
    full_name: 'synth-org/synth-repo',
    name: 'synth-repo',
    owner: { login: 'synth-org' },
    html_url: 'https://github.com/synth-org/synth-repo',
  },
  sender: {
    login: 'synth-dev',
    id: 9001,
    type: 'User',
  },
  installation: { id: 888888 },
};

/** "pull_request" webhook — opened event (synthetic). */
const prOpenedFixture = {
  action: 'opened',
  number: 99,
  pull_request: {
    number: 99,
    title: 'Add event store module',
    body: 'Implements the event store with pg-boss queue.',
    state: 'open' as const,
    merged: false as const,
    merged_at: null,
    draft: false as const,
    created_at: '2026-07-17T11:00:00Z',
    updated_at: '2026-07-17T11:00:00Z',
    user: { login: 'synth-dev', id: 9001, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'b'.repeat(40) },
  },
  repository: {
    full_name: 'synth-org/synth-repo',
    owner: { login: 'synth-org' },
    name: 'synth-repo',
  },
  sender: {
    login: 'synth-dev',
    id: 9001,
    type: 'User',
  },
};

/** "push" webhook fixture (synthetic). */
const pushFixture = {
  ref: 'refs/heads/main',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  created: false,
  deleted: false,
  forced: false,
  repository: {
    full_name: 'synth-org/synth-repo',
    owner: { login: 'synth-org' },
    name: 'synth-repo',
  },
  sender: {
    login: 'synth-dev',
    id: 9001,
    type: 'User',
  },
  commits: [
    {
      id: 'b'.repeat(40),
      timestamp: '2026-07-17T12:00:00Z',
      message: 'Implement event store',
      author: { name: 'Synth Dev', email: 'dev@synth.example.com' },
      distinct: true,
    },
  ],
};

/** "star" event — unsupported in M0 (synthetic). */
const starFixture = {
  action: 'created',
  repository: {
    full_name: 'synth-org/synth-repo',
  },
  sender: {
    login: 'synth-fan',
    id: 9002,
    type: 'User',
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildHeaders(
  eventType: string,
  body: string | Buffer,
  deliveryId = SYNTHETIC_DELIVERY_ID,
  secret = WEBHOOK_SECRET,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-GitHub-Event': eventType,
    'X-GitHub-Delivery': deliveryId,
    'X-Hub-Signature-256': sign(body, secret),
  };
}

function webhookUrl(projectId: string): string {
  return `/v1/connectors/github/webhook?project=${encodeURIComponent(projectId)}`;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!url)('POST /v1/connectors/github/webhook (live Postgres)', () => {
  let pool: Pool;
  let db: AppDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    ({ pool } = connectDatabase());
    db = createDb(url!, { pool: pool as unknown as import('pg').Pool });

    // Ensure test team + project exist
    await db.execute(`
      INSERT INTO teams (id, name) VALUES ('${SYNTHETIC_TEAM}', 'GH08 Test Team')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO projects (id, team_id, name) VALUES ('${SYNTHETIC_PROJECT}', '${SYNTHETIC_TEAM}', 'GH08 Test Project')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Register the GitHub connector with a known secret
    resetConnectors();
    registerConnector(new GitHubConnector({ webhookSecret: WEBHOOK_SECRET }));

    // Build the app with real db
    const deps: AppDeps = { dbUrl: url!, db };
    app = buildApp(deps);
  });

  afterAll(async () => {
    resetConnectors();
    await db.execute(`
      DELETE FROM job_events WHERE project_id = '${SYNTHETIC_PROJECT}';
      DELETE FROM events WHERE project_id = '${SYNTHETIC_PROJECT}';
      DELETE FROM jobs WHERE project_id = '${SYNTHETIC_PROJECT}';
      DELETE FROM principals WHERE team_id = '${SYNTHETIC_TEAM}';
      DELETE FROM projects WHERE id = '${SYNTHETIC_PROJECT}';
      DELETE FROM teams WHERE id = '${SYNTHETIC_TEAM}';
    `);
    await closeDatabase(pool);
  });

  beforeEach(async () => {
    await db.execute(`
      DELETE FROM job_events WHERE project_id = '${SYNTHETIC_PROJECT}';
      DELETE FROM events WHERE project_id = '${SYNTHETIC_PROJECT}';
      DELETE FROM jobs WHERE project_id = '${SYNTHETIC_PROJECT}';
      DELETE FROM principals WHERE team_id = '${SYNTHETIC_TEAM}';
    `);
  });

  // ── SUCCESS: issues event produces event + principal + job ────────────

  it('ACCEPTANCE: signed issues webhook → 1 event, 1 principal, 1 job', async () => {
    const body = JSON.stringify(issuesOpenedFixture);
    const deliveryId = 'gh08-issues-0000-0000-0000-000000000001';

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: buildHeaders('issues', body, deliveryId),
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accepted).toBe(1);
    expect(json.results).toHaveLength(1);
    expect(json.results[0].status).toBe('accepted');
    const eventId = json.results[0].eventId;
    expect(eventId).toMatch(/^evt_[A-Za-z0-9]+$/);

    // Verify event row exists
    const { rows: eventRows } = await db.execute(
      `SELECT id, channel, kind, connector_kind, delivery_id, item_key,
              actor_provenance, occurred_at_provenance, actor_principal_id, payload
       FROM events WHERE id = '${eventId}'`,
    );
    expect(eventRows).toHaveLength(1);
    const evt = eventRows[0] as Record<string, unknown>;
    expect(evt['channel']).toBe('github');
    expect(evt['kind']).toBe('github_issue');
    expect(evt['connector_kind']).toBe('github');
    expect(evt['delivery_id']).toBe(deliveryId);
    expect(evt['actor_provenance']).toBe('webhook_verified');
    expect(evt['occurred_at_provenance']).toBe('provider');

    // Verify private tags were stripped from stored payload
    const storedPayload = evt['payload'] as Record<string, unknown>;
    const issue = storedPayload['issue'] as Record<string, unknown> | undefined;
    const storedBody = typeof issue?.['body'] === 'string' ? issue['body'] : '';
    expect(storedBody).not.toContain('internal: budget is $5k');
    expect(storedBody).not.toContain('<private>');
    expect(storedBody).not.toContain('</private>');
    // The public part should be preserved
    expect(storedBody).toContain('We should evaluate');

    // Verify principal was upserted
    const { rows: principalRows } = await db.execute(
      `SELECT id, kind, provider, provider_kind, provider_user_id, display_login
       FROM principals
       WHERE team_id = '${SYNTHETIC_TEAM}'
         AND provider_kind = 'github'
         AND provider_user_id = '9001'`,
    );
    expect(principalRows).toHaveLength(1);
    const pri = principalRows[0] as Record<string, unknown>;
    expect(pri['kind']).toBe('human');
    expect(pri['provider']).toBe('github');
    expect(pri['display_login']).toBe('synth-dev');

    // Verify principal is linked to event
    const actorPrincipalId = evt['actor_principal_id'] as string;
    expect(actorPrincipalId).toBe(pri['id']);

    // Verify a compile job was created
    const { rows: jobRows } = await db.execute(
      `SELECT id, kind, status, initiated_by_kind, initiated_by_connector, event_count
       FROM jobs WHERE project_id = '${SYNTHETIC_PROJECT}'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(jobRows).toHaveLength(1);
    const job = jobRows[0] as Record<string, unknown>;
    expect(job['kind']).toBe('ingest_event');
    expect(job['status']).toBe('queued');
    expect(job['initiated_by_kind']).toBe('connector');
    expect(job['initiated_by_connector']).toBe('github');
    expect(job['event_count']).toBe(1);
  });

  // ── SUCCESS: PR webhook event ─────────────────────────────────────────

  it('signed pull_request webhook → event + principal', async () => {
    const body = JSON.stringify(prOpenedFixture);
    const deliveryId = 'gh08-pr-0000-0000-0000-000000000002';

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: buildHeaders('pull_request', body, deliveryId),
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accepted).toBe(1);
    expect(json.results[0].status).toBe('accepted');

    const eventId = json.results[0].eventId;
    const { rows } = await db.execute(
      `SELECT kind, delivery_id, actor_provenance FROM events WHERE id = '${eventId}'`,
    );
    expect(rows).toHaveLength(1);
    const evt = rows[0] as Record<string, unknown>;
    expect(evt['kind']).toBe('github_pr');
    expect(evt['delivery_id']).toBe(deliveryId);
    expect(evt['actor_provenance']).toBe('webhook_verified');
  });

  // ── SUCCESS: push webhook → multiple commit events ────────────────────

  it('signed push webhook → one event per commit', async () => {
    const body = JSON.stringify(pushFixture);
    const deliveryId = 'gh08-push-0000-0000-0000-000000000003';

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: buildHeaders('push', body, deliveryId),
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accepted).toBe(1); // one commit
    expect(json.results[0].status).toBe('accepted');

    const eventId = json.results[0].eventId;
    const { rows } = await db.execute(
      `SELECT kind, item_key, delivery_id, actor_provenance
       FROM events WHERE id = '${eventId}'`,
    );
    expect(rows).toHaveLength(1);
    const evt = rows[0] as Record<string, unknown>;
    expect(evt['kind']).toBe('github_commit');
    expect(evt['item_key']).toBe('b'.repeat(40));
    expect(evt['delivery_id']).toBe(deliveryId);
    expect(evt['actor_provenance']).toBe('webhook_verified');
  });

  // ── IDEMPOTENCY: replay same delivery ID + same body → no new rows ──

  it('IDEMPOTENCY: replay same delivery + same body → duplicate, no new rows', async () => {
    const body = JSON.stringify(issuesOpenedFixture);
    const deliveryId = 'gh08-idem-0000-0000-0000-000000000010';

    // First delivery
    const res1 = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: buildHeaders('issues', body, deliveryId),
      body,
    });
    expect(res1.status).toBe(200);
    const j1 = await res1.json();
    expect(j1.accepted).toBe(1);
    const firstEventId = j1.results[0].eventId;

    // Replay — exact same bytes + delivery ID
    const res2 = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: buildHeaders('issues', body, deliveryId),
      body,
    });
    expect(res2.status).toBe(200);
    const j2 = await res2.json();
    expect(j2.accepted).toBe(0);
    expect(j2.duplicate).toBe(1);
    expect(j2.results[0].status).toBe('duplicate');
    expect(j2.results[0].eventId).toBe(firstEventId);

    // Verify only ONE event row exists
    const { rows } = await db.execute(
      `SELECT count(*)::int AS n FROM events
       WHERE project_id = '${SYNTHETIC_PROJECT}' AND delivery_id = '${deliveryId}'`,
    );
    expect(rows[0]).toMatchObject({ n: 1 });

    // Verify only ONE principal row exists
    const { rows: principals } = await db.execute(
      `SELECT count(*)::int AS n FROM principals
       WHERE team_id = '${SYNTHETIC_TEAM}' AND provider_user_id = '9001'`,
    );
    expect(principals[0]).toMatchObject({ n: 1 });
  });

  // ── SECURITY: wrong signature → 401 ──────────────────────────────────

  it('SECURITY: wrong signature → 401, nothing persisted', async () => {
    const body = JSON.stringify(issuesOpenedFixture);
    const deliveryId = 'gh08-sig-0000-0000-0000-000000000020';

    const wrongSig = sign(body, 'wrong-secret-hunter2');

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': wrongSig,
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');

    // Verify nothing was persisted
    const { rows: eventRows } = await db.execute(
      `SELECT count(*)::int AS n FROM events
       WHERE project_id = '${SYNTHETIC_PROJECT}' AND delivery_id = '${deliveryId}'`,
    );
    expect(eventRows[0]).toMatchObject({ n: 0 });

    const { rows: principalRows } = await db.execute(
      `SELECT count(*)::int AS n FROM principals WHERE team_id = '${SYNTHETIC_TEAM}'`,
    );
    expect(principalRows[0]).toMatchObject({ n: 0 });

    const { rows: jobRows } = await db.execute(
      `SELECT count(*)::int AS n FROM jobs WHERE project_id = '${SYNTHETIC_PROJECT}'`,
    );
    expect(jobRows[0]).toMatchObject({ n: 0 });
  });

  // ── SECURITY: missing signature → 401 ────────────────────────────────

  it('SECURITY: missing signature header → 401, nothing persisted', async () => {
    const body = JSON.stringify(issuesOpenedFixture);
    const deliveryId = 'gh08-nosig-0000-0000-0000-000000000021';

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': deliveryId,
        // NO signature header
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('unauthorized');

    const { rows } = await db.execute(
      `SELECT count(*)::int AS n FROM events
       WHERE project_id = '${SYNTHETIC_PROJECT}' AND delivery_id = '${deliveryId}'`,
    );
    expect(rows[0]).toMatchObject({ n: 0 });
  });

  // ── UNSUPPORTED EVENT: star → 200 accepted/ignored, no rows/jobs ────

  it('UNSUPPORTED: star event → 200 ignored, zero rows/jobs', async () => {
    const body = JSON.stringify(starFixture);
    const deliveryId = 'gh08-star-0000-0000-0000-000000000030';

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: buildHeaders('star', body, deliveryId),
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accepted).toBe(0);
    expect(json.duplicate).toBe(0);
    expect(json.ignored).toBe(1); // the delivery was received but produced no events
    expect(json.results).toEqual([]);

    // Verify no event rows
    const { rows: eventRows } = await db.execute(
      `SELECT count(*)::int AS n FROM events
       WHERE project_id = '${SYNTHETIC_PROJECT}' AND delivery_id = '${deliveryId}'`,
    );
    expect(eventRows[0]).toMatchObject({ n: 0 });

    // Verify no jobs
    const { rows: jobRows } = await db.execute(
      `SELECT count(*)::int AS n FROM jobs WHERE project_id = '${SYNTHETIC_PROJECT}'`,
    );
    expect(jobRows[0]).toMatchObject({ n: 0 });

    // Verify no principals (star event's sender should not create a principal)
    const { rows: principalRows } = await db.execute(
      `SELECT count(*)::int AS n FROM principals WHERE team_id = '${SYNTHETIC_TEAM}'`,
    );
    expect(principalRows[0]).toMatchObject({ n: 0 });
  });

  // ── BOUNDARY: missing delivery ID → 200 ignored, nothing persisted ──

  it('BOUNDARY: missing delivery ID → 200 ignored, no rows', async () => {
    const body = JSON.stringify(issuesOpenedFixture);

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sign(body),
        // NO X-GitHub-Delivery header
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accepted).toBe(0);
    expect(json.ignored).toBeGreaterThanOrEqual(1);

    const { rows } = await db.execute(
      `SELECT count(*)::int AS n FROM events WHERE project_id = '${SYNTHETIC_PROJECT}'`,
    );
    expect(rows[0]).toMatchObject({ n: 0 });
  });

  // ── BOUNDARY: non-existent project → 404 ─────────────────────────────

  it('BOUNDARY: non-existent project → 404', async () => {
    const body = JSON.stringify(issuesOpenedFixture);
    const deliveryId = 'gh08-noproj-0000-0000-0000-000000000040';

    const res = await app.request(
      `/v1/connectors/github/webhook?project=prj_nonexistent000000`,
      {
        method: 'POST',
        headers: buildHeaders('issues', body, deliveryId),
        body,
      },
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('not_found');
  });

  // ── BOUNDARY: unregistered connector → 404 ────────────────────────────

  it('BOUNDARY: unregistered connector kind → 404', async () => {
    const body = JSON.stringify(issuesOpenedFixture);
    const deliveryId = 'gh08-noconn-0000-0000-0000-000000000050';

    const res = await app.request(
      `/v1/connectors/slack/webhook?project=${SYNTHETIC_PROJECT}`,
      {
        method: 'POST',
        headers: buildHeaders('issues', body, deliveryId),
        body,
      },
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('not_found');
  });

  // ── CASE-INSENSITIVE: signature header with different case ───────────

  it('CASE-INSENSITIVE: X-Hub-Signature-256 header with alternate case still validates', async () => {
    const body = JSON.stringify(issuesOpenedFixture);
    const deliveryId = 'gh08-case-0000-0000-0000-000000000060';

    const sig = sign(body);

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': deliveryId,
        'X-HUB-SIGNATURE-256': sig, // uppercase
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accepted).toBe(1);
  });

  // ── IDEMPOTENCY: different delivery ID → new event, not duplicate ────

  it('IDEMPOTENCY: different delivery ID with same body → new event', async () => {
    const body = JSON.stringify(issuesOpenedFixture);

    const res1 = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: buildHeaders('issues', body, 'gh08-diff-0000-0000-0000-000000000071'),
      body,
    });
    expect(res1.status).toBe(200);
    const j1 = await res1.json();
    expect(j1.accepted).toBe(1);

    const res2 = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: buildHeaders('issues', body, 'gh08-diff-0000-0000-0000-000000000072'),
      body,
    });
    expect(res2.status).toBe(200);
    const j2 = await res2.json();
    expect(j2.accepted).toBe(1);
    // Different event IDs
    expect(j2.results[0].eventId).not.toBe(j1.results[0].eventId);

    // Two rows
    const { rows } = await db.execute(
      `SELECT count(*)::int AS n FROM events
       WHERE project_id = '${SYNTHETIC_PROJECT}'
         AND delivery_id LIKE 'gh08-diff-%'`,
    );
    expect(rows[0]).toMatchObject({ n: 2 });
  });

  // ── SECURITY: error message does not leak secret ──────────────────────

  it('SECURITY: 401 error response does not leak webhook secret', async () => {
    const body = JSON.stringify(issuesOpenedFixture);

    const res = await app.request(webhookUrl(SYNTHETIC_PROJECT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': 'gh08-leak-0000-0000-0000-000000000080',
        'X-Hub-Signature-256': 'sha256=deadbeef00000000000000000000000000000000000000000000000000000000',
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.message).not.toContain(WEBHOOK_SECRET);
    expect(json.error.message).not.toContain('deadbeef');
    expect(JSON.stringify(json)).not.toContain(WEBHOOK_SECRET);
  });
});
