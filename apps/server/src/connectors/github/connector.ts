/**
 * GitHub Connector (M0-GH-08 / DUA-148).
 *
 * Implements the {@link Connector} interface from `registry.ts`. Owns:
 *   1. Signature verification (delegates to `signature.ts`).
 *   2. Event-type dispatch to the appropriate per-event normalizer
 *      (`push.ts`, `pull-request.ts`, `issue.ts`, `comments.ts`).
 *   3. Unsupported events → honest `[]` (no data rows, no jobs).
 *
 * Each per-event normalizer already owns redaction (where applicable),
 * actor resolution, and provenance assignment. This module composes them.
 */
import { z } from 'zod';
import type { Connector, WebhookRequest, NormalizedEvent } from '../registry.js';
import {
  getHeaderCaseInsensitive,
  verifyGitHubSignature,
} from './signature.js';
import {
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  extractDeliveryId,
} from './common.js';
import { normalizePushEvent } from './push.js';
import { normalizePullRequestEvent, type PullRequestNormalizationContext } from './pull-request.js';
import { normalizeGithubIssueEvent, type NormalizeGithubIssueInput } from './issue.js';
import { normalizeCommentEvent, type NormalizeCommentEventInput } from './comments.js';

// ── Configuration ──────────────────────────────────────────────────────────

/**
 * Configuration required to create a GitHub connector.
 * All fields come from environment / deployment config.
 */
export interface GitHubConnectorConfig {
  /** Webhook secret for HMAC-SHA256 signature verification. */
  readonly webhookSecret: string;
}

// ── Raw payload schema (loose — we validate only that it parses) ────────────

const jsonObjectSchema = z.record(z.string(), z.unknown());

// ── Connector implementation ────────────────────────────────────────────────

/**
 * A GitHub Connector that verifies webhook signatures and normalises the
 * delivery into zero or more {@link NormalizedEvent}s.
 *
 * One webhook delivery may expand into multiple events (a push with many
 * commits). Unsupported event types or actions return `[]` — the caller
 * responds with "accepted / ignored" and creates no data rows or jobs.
 */
export class GitHubConnector implements Connector {
  readonly kind = 'github';
  private readonly secret: string;

  constructor(config: GitHubConnectorConfig) {
    this.secret = config.webhookSecret;
  }

  async handleWebhook(req: WebhookRequest): Promise<NormalizedEvent[]> {
    // 1. Extract headers
    const signature = getHeaderCaseInsensitive(req.headers, GITHUB_SIGNATURE_HEADER);
    const rawEvent = getHeaderCaseInsensitive(req.headers, GITHUB_EVENT_HEADER);

    // 2. Verify signature (throws SignatureVerificationError → 401)
    verifyGitHubSignature(req.rawBody, signature, this.secret);

    // 3. Require delivery ID (N1 — idempotency anchor)
    const deliveryId = extractDeliveryId(
      req.headers as Record<string, string | undefined>,
    );
    if (!deliveryId) {
      // A webhook without a delivery ID cannot be idempotently stored.
      // Return nothing rather than fabricate an id.
      return [];
    }

    // 4. Require event type
    if (typeof rawEvent !== 'string' || rawEvent.trim() === '') {
      return [];
    }

    // 5. Parse the JSON body (Zod-validated cross-boundary input)
    const parsed = jsonObjectSchema.safeParse(
      JSON.parse(req.rawBody.toString('utf-8')),
    );
    if (!parsed.success) {
      return [];
    }

    const body = parsed.data;
    const serverTime = new Date().toISOString();

    // 6. Dispatch by event type
    switch (rawEvent) {
      case 'push':
        return normalizePushEvent({
          deliveryId,
          payload: body,
          webhookVerified: true,
        });

      case 'pull_request': {
        const ctx: PullRequestNormalizationContext = {
          deliveryId,
          webhookVerified: true,
          serverReceiveTime: serverTime,
        };
        const event = normalizePullRequestEvent(
          body as Parameters<typeof normalizePullRequestEvent>[0],
          ctx,
        );
        return event ? [event] : [];
      }

      case 'issues': {
        const input: NormalizeGithubIssueInput = {
          payload: body,
          deliveryId,
          webhookVerified: true,
        };
        const result = normalizeGithubIssueEvent(input);
        return result.ok ? [result.event] : [];
      }

      case 'issue_comment':
      case 'pull_request_review':
      case 'pull_request_review_comment': {
        const input: NormalizeCommentEventInput = {
          githubEvent: rawEvent,
          payload: body,
          deliveryId,
          webhookVerified: true,
          serverTime,
        };
        const event = normalizeCommentEvent(input);
        return event ? [event] : [];
      }

      default:
        // Unsupported event type — honest "accepted/ignored"
        return [];
    }
  }
}
