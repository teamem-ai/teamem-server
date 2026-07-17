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

/**
 * Actor claim a connector resolves from its raw payload (N2). Identity
 * resolution belongs in the connector — only it can verify a signature and
 * therefore justify `webhook_verified`; pushing it back into the ingestion
 * layer would contradict the frozen N2 direction. `null` means unknown —
 * never fabricated.
 */
export interface NormalizedActor {
  kind: 'human' | 'service';
  provider: string; // open — "github", future "slack", …
  providerUserId: string;
  displayLogin?: string;
}

export interface NormalizedEvent {
  /** Open connector identifier, e.g. "github", "slack". */
  connectorKind: string;
  /** Open connector-specific event identifier, e.g. "pull_request.closed". */
  eventKind: string;
  /** Raw provider event/action names, if any (Q6). */
  sourceEvent?: string;
  sourceAction?: string;
  deliveryId: string;
  itemKey: string; // sub-item id within one delivery; 'root' when unsplit (N1)
  externalId: string;
  url?: string;
  /** Resolved actor claim (N2). null = unknown, never fabricated. */
  actor: NormalizedActor | null;
  actorProvenance: 'webhook_verified' | 'credential_bound' | 'client_claimed' | 'unknown';
  occurredAt: string;
  occurredAtProvenance: 'provider' | 'client' | 'server';
  payload: Record<string, unknown>;
}

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
