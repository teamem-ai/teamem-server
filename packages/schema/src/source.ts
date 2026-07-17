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
 */
export const sourceChannel = z.enum(['github', 'cli', 'mcp']);
export type SourceChannel = z.infer<typeof sourceChannel>;

/** Parsed event classification (Q6). */
export const sourceKind = z.enum([
  'github_commit',
  'github_pr',
  'github_issue',
  'github_pr_comment',
  'cli_init',
  'mcp_write',
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
export const source = z.strictObject({
  channel: sourceChannel, // channel fact, server-derived (N1)
  kind: sourceKind,
  event: z.string().optional(), // raw provider event name (Q6, github only)
  action: z.string().optional(), // raw provider action (Q6)
  deliveryId: z.string().min(1), // idempotency identity component (N1):
  // github → X-GitHub-Delivery (connector-filled);
  // cli → client idempotencyKey; mcp → server-generated UUID per tool call
  itemKey: z.string().min(1), // stable sub-item id within one delivery
  // (commit SHA, comment id, …); fixed 'root' when the delivery isn't split
  externalId: z.string().min(1), // human-meaningful ref, e.g. "org/repo#42"
  url: z.url().optional(),
});
export type Source = z.infer<typeof source>;

/** Source descriptor as submitted on the public REST channel. */
export const sourceInput = z.strictObject({
  kind: publicIngestKind,
  externalId: z.string().min(1),
  url: z.url().optional(),
});
export type SourceInput = z.infer<typeof sourceInput>;
