/**
 * GitHub Connector — implements the Connector interface (AGPL-3.0-only).
 *
 * Composes signature verification (DUA-141), the four normalizers
 * (push/issue/PR/comments), and the shared header helpers into one
 * registered connector. This is the object that plugs into the connector
 * registry and is called by the webhook HTTP route.
 *
 * Red lines:
 *   - Only signature-verified deliveries produce `actorProvenance:
 *     'webhook_verified'` (N2).
 *   - Missing X-GitHub-Delivery → rejected (no fabricated identity, N1).
 *   - Unhandled event types → empty [] (never silently coerced).
 */
import { verifyGitHubSignature, SignatureVerificationError } from './signature.js';
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
} from './common.js';
import { getHeaderCaseInsensitive as getHeader } from './signature.js';
import { normalizePushEvent } from './push.js';
import { normalizePullRequestEvent } from './pull-request.js';
import { normalizeGithubIssueEvent } from './issue.js';
import { normalizeCommentEvent } from './comments.js';
import type { Connector, NormalizedEvent, WebhookRequest } from '../registry.js';

export interface GitHubConnectorOptions {
  /**
   * Webhook secret for HMAC-SHA256 signature verification.
   * When undefined, signature verification is skipped and all deliveries
   * earn `webhookVerified: false` → `actorProvenance: 'unknown'`.
   */
  readonly webhookSecret?: string;
}

/**
 * Full GitHub Connector.
 *
 * Registered once at startup; handles all supported GitHub event types
 * (push, pull_request, issues, issue_comment, pull_request_review,
 * pull_request_review_comment).
 */
export class GitHubConnector implements Connector {
  readonly kind = 'github';
  readonly #secret: string | undefined;

  constructor(options: GitHubConnectorOptions = {}) {
    this.#secret = options.webhookSecret;
  }

  async handleWebhook(req: WebhookRequest): Promise<NormalizedEvent[]> {
    const deliveryId = getHeader(req.headers, GITHUB_DELIVERY_HEADER);
    if (!deliveryId) {
      // N1: never fabricate an idempotency identity. A missing delivery id
      // means we cannot build trustworthy identity — reject the whole delivery.
      throw new SignatureVerificationError(
        'Missing X-GitHub-Delivery header — cannot establish idempotent identity (N1)',
      );
    }

    const githubEvent = getHeader(req.headers, GITHUB_EVENT_HEADER);
    if (!githubEvent) {
      // Without the event type we don't know which normalizer to call.
      // Return empty — do not guess.
      return [];
    }

    // Signature verification — if a secret is configured, verify.
    // If not, all events get webhookVerified=false.
    let webhookVerified = false;
    if (this.#secret) {
      verifyGitHubSignature(
        req.rawBody,
        getHeader(req.headers, GITHUB_SIGNATURE_HEADER),
        this.#secret,
      );
      webhookVerified = true;
    }

    // Parse the JSON body. Use a Buffer so we don't lose the raw bytes
    // (they were already consumed by verifyGitHubSignature above via rawBody).
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      // Not valid JSON — nothing to normalize.
      return [];
    }

    const serverTime = new Date().toISOString();

    // Route to the appropriate normalizer based on X-GitHub-Event.
    switch (githubEvent) {
      case 'push': {
        return normalizePushEvent({ deliveryId, payload, webhookVerified });
      }

      case 'pull_request': {
        const event = normalizePullRequestEvent(payload, {
          deliveryId,
          webhookVerified,
          serverReceiveTime: serverTime,
        });
        return event ? [event] : [];
      }

      case 'issues': {
        const result = normalizeGithubIssueEvent({
          payload,
          deliveryId,
          webhookVerified,
        });
        return result.ok ? [result.event] : [];
      }

      case 'issue_comment':
      case 'pull_request_review':
      case 'pull_request_review_comment': {
        const event = normalizeCommentEvent({
          githubEvent,
          payload,
          deliveryId,
          webhookVerified,
          serverTime,
        });
        return event ? [event] : [];
      }

      default:
        // Unhandled event type — skip, don't fabricate.
        return [];
    }
  }
}
