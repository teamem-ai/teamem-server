/**
 * Connector registry (SaaS pre-provisioning — MVP plan §9.1 mechanism 5).
 *
 * Ingestion sources register through one interface. GitHub is the first
 * built-in implementation (M0). Future Slack/Gmail connectors are private
 * npm packages implementing this SAME interface and registered at startup —
 * the open repository does not change to gain them.
 *
 * Layering (fixed after acceptance review): a connector's output is an
 * INTERNAL producer contract, not a public API DTO. It therefore uses OPEN
 * string identifiers (`connectorKind`/`eventKind`), NOT @teamem/schema's
 * closed `SourceChannel`/`SourceKind` enums. A private Slack package can emit
 * a real, non-empty event without touching the open schema, the Postgres
 * enum, or a migration. The ingestion layer maps a NormalizedEvent onto the
 * stored `channel`/`kind` (built-in connectors → existing enum values;
 * unknown connectors → the generic external channel).
 */

import { z } from 'zod';
import { actorProvenance, isoDateTime, occurredAtProvenance } from '@teamem/schema';

/**
 * Actor claim a connector resolves from its raw payload (N2). Identity
 * resolution belongs in the connector — only it can verify a signature and
 * therefore justify `webhook_verified`; pushing it back into the ingestion
 * layer would contradict the frozen N2 direction. `null` means unknown —
 * never fabricated.
 *
 * Runtime-validated (not just typed) because this is a cross-boundary input:
 * a private connector package is untrusted code from the storage layer's
 * point of view (project rule — every cross-boundary input goes through Zod).
 */
export const normalizedActorSchema = z.strictObject({
  kind: z.enum(['human', 'service']),
  provider: z.string().min(1), // open — "github", future "slack", …
  providerUserId: z.string().min(1),
  displayLogin: z.string().optional(),
});
export type NormalizedActor = z.infer<typeof normalizedActorSchema>;

export const normalizedEventSchema = z.strictObject({
  /** Open connector identifier, e.g. "github", "slack". */
  connectorKind: z.string().min(1),
  /** Open connector-specific event identifier, e.g. "pull_request.closed". */
  eventKind: z.string().min(1),
  /** Raw provider event/action names, if any (Q6). */
  sourceEvent: z.string().optional(),
  sourceAction: z.string().optional(),
  deliveryId: z.string().min(1),
  itemKey: z.string().min(1), // sub-item id within one delivery; 'root' when unsplit (N1)
  externalId: z.string().min(1),
  url: z.url().optional(),
  /** Resolved actor claim (N2). null = unknown, never fabricated. */
  actor: normalizedActorSchema.nullable(),
  actorProvenance,
  occurredAt: isoDateTime,
  occurredAtProvenance,
  payload: z.record(z.string(), z.unknown()),
});
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
}

export interface Connector {
  /** Stable open identifier, e.g. "github". */
  readonly kind: string;
  /**
   * Verify authenticity (e.g. webhook signature) and normalize into events.
   * One delivery may expand into several events (a push with many commits) —
   * each gets a distinct itemKey (N1). Returns [] for events to ignore.
   * Throws on signature failure — the caller maps that to 401.
   */
  handleWebhook(req: WebhookRequest): Promise<NormalizedEvent[]>;
}

const connectors = new Map<string, Connector>();

export function registerConnector(connector: Connector): void {
  if (connectors.has(connector.kind)) {
    throw new Error(`connector already registered: ${connector.kind}`);
  }
  connectors.set(connector.kind, connector);
}

export function getConnector(kind: string): Connector | undefined {
  return connectors.get(kind);
}

export function listConnectors(): readonly Connector[] {
  return [...connectors.values()];
}

/** Test/composition helper — clears all registrations. */
export function resetConnectors(): void {
  connectors.clear();
}
