/**
 * Ingestion sources. (Contract v0.2 Appendix A — decisions Q6/N1/N2.)
 */
import { z } from 'zod';

/**
 * The ingestion CHANNEL — an original source fact known to the server from
 * how the event arrived (webhook endpoint = github, MCP endpoint = mcp,
 * REST API = cli). Named "channel" deliberately: "provider" is reserved for
 * identity providers (actor.provider) — these are different dimensions even
 * when the values coincide. N1: idempotent identity is built on the channel,
 * never on `kind` (kind is a parse result; parser changes must not bypass
 * dedup).
 *
 * `external` (v0.3 additive, DUA-129): the generic bucket for any connector
 * outside the built-in three (private Slack/Gmail/… packages implementing
 * `connectors/registry.ts`'s `Connector` interface). Their real identity is
 * open-ended (`connectorKind`) and never forced into this closed enum — see
 * `source.connectorKind` below.
 */
export const sourceChannel = z.enum(['github', 'cli', 'mcp', 'external']);
export type SourceChannel = z.infer<typeof sourceChannel>;

/**
 * Parsed event classification (Q6).
 *
 * `external_event` (v0.3 additive, DUA-129): parse-result bucket paired with
 * `channel: 'external'`. The connector's real open event identifier is
 * preserved verbatim in `source.event` (not squeezed into this closed enum).
 */
export const sourceKind = z.enum([
  'github_commit',
  'github_pr',
  'github_issue',
  'github_pr_comment',
  'cli_init',
  'mcp_write',
  'external_event',
]);
export type SourceKind = z.infer<typeof sourceKind>;

/**
 * Kinds accepted on the public REST ingestion endpoint.
 *
 * Channel coherence (derived from N1 provider-as-channel-fact + N2-③):
 * github_* events exist only via the internal signature-verifying webhook
 * connector; mcp_write events are constructed internally by the MCP endpoint.
 * The public REST channel therefore accepts only `cli_init`. Additional
 * public kinds (CI events, …) are additive in later versions.
 */
export const publicIngestKind = z.enum(['cli_init']);

/** Source descriptor as stored/returned (server-enriched). */
const sourceShape = z.strictObject({
  channel: sourceChannel, // channel fact, server-derived (N1)
  kind: sourceKind,
  event: z.string().optional(), // raw provider event name (Q6, github only;
  // also carries the connector's real open eventKind when channel=external)
  action: z.string().optional(), // raw provider action (Q6)
  deliveryId: z.string().min(1), // idempotency identity component (N1):
  // github → X-GitHub-Delivery (connector-filled);
  // cli → client idempotencyKey; mcp → server-generated UUID per tool call
  itemKey: z.string().min(1), // stable sub-item id within one delivery
  // (commit SHA, comment id, …); fixed 'root' when the delivery isn't split
  externalId: z.string().min(1), // human-meaningful ref, e.g. "org/repo#42"
  url: z.url().optional(),
  // v0.3 additive (DUA-129): the connector's real open identity — REQUIRED
  // when channel is 'external', absent for the three built-in channels
  // (whose connectorKind == channel and needs no duplicate field). Part of
  // the idempotency identity alongside channel/deliveryId/itemKey so two
  // different private connectors (e.g. slack, gmail) sharing the generic
  // external channel and colliding delivery IDs cannot be confused for one
  // another.
  connectorKind: z.string().min(1).optional(),
});

/**
 * The channel <-> connectorKind pairing is enforced, not merely documented
 * (acceptance-review finding, DUA-129): a plain optional field let both
 * `channel='external'` with no connectorKind AND a built-in channel WITH a
 * connectorKind parse successfully, silently defeating the identity
 * guarantee the field exists for.
 */
export const source = sourceShape.superRefine((val, ctx) => {
  if (val.channel === 'external' && !val.connectorKind) {
    ctx.addIssue({
      code: 'custom',
      message: "connectorKind is required when channel is 'external'",
      path: ['connectorKind'],
    });
  }
  if (val.channel !== 'external' && val.connectorKind !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'connectorKind must be absent for built-in channels (github/cli/mcp)',
      path: ['connectorKind'],
    });
  }
});
export type Source = z.infer<typeof source>;

/** Source descriptor as submitted on the public REST channel. */
export const sourceInput = z.strictObject({
  kind: publicIngestKind,
  externalId: z.string().min(1),
  url: z.url().optional(),
});
export type SourceInput = z.infer<typeof sourceInput>;
