#!/usr/bin/env tsx
/**
 * M0 GitHub Smoke Test — Ingestion Helper (AGPL-3.0-only)
 *
 * This TypeScript helper bridges the gap between real GitHub events (created
 * by the bash smoke-test script via `gh` CLI) and the teamem event storage
 * layer. It normalizes a GitHub webhook payload using the existing connector
 * normalizers and persists it via `connector-storage.ts`.
 *
 * Usage (called from scripts/m0-github-smoke.sh):
 *   tsx scripts/m0-github-smoke-ingest.ts <event-type> <delivery-id> <verified> [<owner/repo>]
 *     --payload-file=<path>       # read raw GitHub payload from file
 *     --db-url=<url>              # Postgres connection string
 *
 * Event types: push | pull_request | issues | issue_comment | pull_request_review
 *
 * Output: single JSON line with {eventId, principalId, status, channel, kind, ...}
 *
 * Exit codes: 0 = success (inserted or duplicate), 1 = usage/input error
 */

import { readFileSync } from 'node:fs';

// Dynamic imports so tsx can resolve them from the monorepo workspace
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(
      'Usage: tsx scripts/m0-github-smoke-ingest.ts <event-type> <delivery-id> <verified> [owner/repo] --payload-file=<path> --db-url=<url>',
    );
    process.exit(1);
  }

  const eventType = args[0]!;
  const deliveryId = args[1]!;
  const webhookVerified = args[2] === 'true';
  const repoFullName = args[3] ?? '';

  let payloadFile = '';
  let dbUrl = '';
  for (const arg of args.slice(4)) {
    if (arg.startsWith('--payload-file=')) {
      payloadFile = arg.slice('--payload-file='.length);
    } else if (arg.startsWith('--db-url=')) {
      dbUrl = arg.slice('--db-url='.length);
    }
  }

  if (!payloadFile) {
    console.error('missing --payload-file');
    process.exit(1);
  }
  if (!dbUrl) {
    console.error('missing --db-url');
    process.exit(1);
  }

  const rawPayload = JSON.parse(readFileSync(payloadFile, 'utf8'));

  // ── Lazy-load server modules ──────────────────────────────────────────────
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

  // ── Resolve scope (team + project from env or defaults) ──────────────────
  const scope: ConnectorScope = {
    teamId: process.env['TEAMEM_SMOKE_TEAM_ID'] ?? 'team_smoke',
    projectId: process.env['TEAMEM_SMOKE_PROJECT_ID'] ?? 'prj_smoke',
  };

  // Ensure team and project exist (idempotent)
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
        const events = normalizePushEvent({
          deliveryId,
          payload: rawPayload,
          webhookVerified,
        });
        for (const ev of events) {
          const result = await persistNormalizedEvent(db, scope, ev);
          normalizedEvents.push(result);
        }
        break;
      }
      case 'pull_request': {
        const event = normalizePullRequestEvent(rawPayload, {
          deliveryId,
          webhookVerified,
          serverReceiveTime: serverTime,
        });
        if (event) {
          normalizedEvents.push(await persistNormalizedEvent(db, scope, event));
        }
        break;
      }
      case 'issues': {
        const parsed = normalizeGithubIssueEvent({
          payload: rawPayload,
          deliveryId,
          webhookVerified,
        });
        if (parsed.ok) {
          normalizedEvents.push(
            await persistNormalizedEvent(db, scope, parsed.event),
          );
        }
        break;
      }
      case 'issue_comment':
      case 'pull_request_review':
      case 'pull_request_review_comment': {
        const event = normalizeCommentEvent({
          githubEvent: eventType,
          payload: rawPayload,
          deliveryId,
          webhookVerified,
          serverTime,
        });
        if (event) {
          normalizedEvents.push(await persistNormalizedEvent(db, scope, event));
        }
        break;
      }
      default:
        console.error(`unknown event type: ${eventType}`);
        process.exit(1);
    }

    // ── Output JSON result ────────────────────────────────────────────────
    const result = {
      eventType,
      deliveryId,
      repoFullName: repoFullName || null,
      normalizedCount: normalizedEvents.length,
      results: normalizedEvents.map((r) => ({
        eventId: r.eventId,
        principalId: r.principalId,
        channel: r.channel,
        connectorKind: r.connectorKind,
        duplicate: r.duplicate,
      })),
    };

    process.stdout.write(JSON.stringify(result) + '\n');
    await closeDb(db);
    process.exit(0);
  } catch (err) {
    console.error('ingest error:', err instanceof Error ? err.message : String(err));
    try { await closeDb(db); } catch {}
    process.exit(1);
  }
}

void main();
