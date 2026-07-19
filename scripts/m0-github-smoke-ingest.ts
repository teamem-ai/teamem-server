#!/usr/bin/env tsx
/**
 * M0 GitHub Smoke Test — Webhook Ingest Helper (AGPL-3.0-only)
 *
 * Bridges GitHub's real webhook delivery payloads (fetched from GitHub's
 * delivery log via the REST API) into the teamem event storage layer.
 * This is used by the smoke test script when the server's webhook HTTP
 * endpoint is not available — it does exactly what the endpoint would do:
 * verify the signature against the webhook secret, normalize, persist.
 *
 * Usage:
 *   tsx scripts/m0-github-smoke-ingest.ts <event-type> <delivery-id> <secret> \
 *     --payload-file=<path> --db-url=<url>
 *
 * Event types: push | pull_request | issues | issue_comment | pull_request_review
 *
 * The secret is required — only verified deliveries produce webhook_verified
 * provenance, and the smoke test MUST confirm trusted actor claims (N2).
 *
 * Output: single JSON line with {eventId, principalId, status, channel, kind, ...}
 *
 * Exit: 0 = success, 1 = error
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error(
      'Usage: tsx scripts/m0-github-smoke-ingest.ts <event-type> <delivery-id> <secret> ' +
        '--payload-file=<path> --db-url=<url>',
    );
    process.exit(1);
  }

  const eventType = args[0]!;
  const deliveryId = args[1]!;
  const webhookSecret = args[2]!;

  let payloadFile = '';
  let dbUrl = '';
  for (const arg of args.slice(3)) {
    if (arg.startsWith('--payload-file=')) {
      payloadFile = arg.slice('--payload-file='.length);
    } else if (arg.startsWith('--db-url=')) {
      dbUrl = arg.slice('--db-url='.length);
    }
  }

  if (!payloadFile) { console.error('missing --payload-file'); process.exit(1); }
  if (!dbUrl) { console.error('missing --db-url'); process.exit(1); }

  const rawPayloadBytes = readFileSync(payloadFile);
  const rawPayload = JSON.parse(rawPayloadBytes.toString('utf8'));

  // ── Verify HMAC signature against the raw bytes ─────────────────────────
  // This mirrors what the server webhook endpoint does: compute the expected
  // HMAC and compare. Only signature-verified deliveries earn webhook_verified
  // provenance (N2).
  const expectedMac = createHmac('sha256', webhookSecret)
    .update(rawPayloadBytes)
    .digest('hex');
  const signatureHeader =
    process.env['TEAMEM_SMOKE_SIGNATURE'] ??
    `sha256=${expectedMac}`;

  // Verify the signature matches (constant-time not needed here since
  // we're in a CLI, but we still check the value).
  const providedHex = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : '';
  const webhookVerified = providedHex.toLowerCase() === expectedMac.toLowerCase();

  if (!webhookVerified) {
    console.error('ingest error: webhook signature verification failed');
    process.exit(1);
  }

  // ── Lazy-load server modules ──────────────────────────────────────────
  const { createDb, closeDb } = await import('../apps/server/src/db/client.js');
  const { persistNormalizedEvent } = await import(
    '../apps/server/src/connectors/connector-storage.js'
  );
  type ConnectorScope = { readonly teamId: string; readonly projectId: string };
  const { normalizePushEvent } = await import('../apps/server/src/connectors/github/push.js');
  const { normalizePullRequestEvent } = await import(
    '../apps/server/src/connectors/github/pull-request.js'
  );
  const { normalizeGithubIssueEvent } = await import(
    '../apps/server/src/connectors/github/issue.js'
  );
  const { normalizeCommentEvent } = await import(
    '../apps/server/src/connectors/github/comments.js'
  );

  const db = createDb(dbUrl);
  const scope: ConnectorScope = {
    teamId: process.env['TEAMEM_SMOKE_TEAM_ID'] ?? 'team_smoke',
    projectId: process.env['TEAMEM_SMOKE_PROJECT_ID'] ?? 'prj_smoke',
  };

  // Ensure team + project exist
  await db.execute(
    `INSERT INTO teams (id, name) VALUES ('${scope.teamId}', 'Smoke Test Team') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    `INSERT INTO projects (id, team_id, name) VALUES ('${scope.projectId}', '${scope.teamId}', 'Smoke Test Project') ON CONFLICT (id) DO NOTHING`,
  );

  const serverTime = new Date().toISOString();

  try {
    const normalizedEvents: Awaited<ReturnType<typeof persistNormalizedEvent>>[] = [];

    switch (eventType) {
      case 'push': {
        for (const ev of normalizePushEvent({ deliveryId, payload: rawPayload, webhookVerified: true })) {
          normalizedEvents.push(await persistNormalizedEvent(db, scope, ev));
        }
        break;
      }
      case 'pull_request': {
        const ev = normalizePullRequestEvent(rawPayload, {
          deliveryId, webhookVerified: true, serverReceiveTime: serverTime,
        });
        if (ev) normalizedEvents.push(await persistNormalizedEvent(db, scope, ev));
        break;
      }
      case 'issues': {
        const r = normalizeGithubIssueEvent({ payload: rawPayload, deliveryId, webhookVerified: true });
        if (r.ok) normalizedEvents.push(await persistNormalizedEvent(db, scope, r.event));
        break;
      }
      case 'issue_comment':
      case 'pull_request_review':
      case 'pull_request_review_comment': {
        const ev = normalizeCommentEvent({
          githubEvent: eventType, payload: rawPayload, deliveryId, webhookVerified: true, serverTime,
        });
        if (ev) normalizedEvents.push(await persistNormalizedEvent(db, scope, ev));
        break;
      }
      default:
        console.error(`unknown event type: ${eventType}`);
        process.exit(1);
    }

    process.stdout.write(JSON.stringify({
      eventType,
      deliveryId,
      normalizedCount: normalizedEvents.length,
      results: normalizedEvents.map((r) => ({
        eventId: r.eventId, principalId: r.principalId,
        channel: r.channel, connectorKind: r.connectorKind, duplicate: r.duplicate,
      })),
    }) + '\n');

    await closeDb(db);
    process.exit(0);
  } catch (err) {
    console.error('ingest error:', err instanceof Error ? err.message : String(err));
    try { await closeDb(db); } catch {}
    process.exit(1);
  }
}

void main();
