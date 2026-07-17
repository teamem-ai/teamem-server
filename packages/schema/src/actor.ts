/**
 * Actor & provenance. (Contract v0.2 Appendix A — decisions N2/N8.)
 *
 * Principle (general rule of the contract): always preserve original facts —
 * the raw actor claim, its provenance, and the authenticated credential are
 * stored separately; resolution can be re-run, a resolved string cannot.
 */
import { z } from 'zod';
import { credentialId, principalId } from './common.js';

/**
 * The subject claimed by the source event. `kind` is the subject type and
 * `provider` is the identity provider — deliberately separate dimensions
 * (N2: bots/service accounts are legitimate subjects).
 */
export const actor = z.strictObject({
  kind: z.enum(['human', 'service']),
  provider: z.enum(['github']), // additive registry — future: slack, …
  providerUserId: z.string().min(1), // stable numeric id; logins are mutable
  displayLogin: z.string().optional(), // display snapshot only, never identity
});
export type Actor = z.infer<typeof actor>;

/**
 * How the actor claim was obtained (N2). States the acquisition channel, not
 * a truth verdict: `credential_bound` proves the key↔principal binding only —
 * keys can be shared or driven by automation.
 * Contract clause: client-submitted actors can NEVER obtain `webhook_verified`.
 */
export const actorProvenance = z.enum([
  'webhook_verified', // extracted server-side from a signature-verified payload
  'credential_bound', // resolved from the authenticated API key binding
  'client_claimed', // submitted by the client; displayed as a claim only
  'unknown', // no actor information — never fabricated (N2)
]);
export type ActorProvenance = z.infer<typeof actorProvenance>;

/**
 * How `occurredAt` was obtained (N8: time trust is a separate fact from
 * actor trust — one field cannot express "verified actor, claimed time").
 */
export const occurredAtProvenance = z.enum([
  'provider', // extracted from a signature-verified provider payload
  'client', // claimed by the submitter
  'server', // server receive-time fallback when absent
]);
export type OccurredAtProvenance = z.infer<typeof occurredAtProvenance>;

/** Server-side authenticated ingestion context (N2: never client-supplied). */
export const ingestedBy = z.strictObject({
  credentialId: credentialId.nullable(), // null for internal connector channels
  principalId: principalId.nullable(), // resolved at event time; never rewritten
});
export type IngestedBy = z.infer<typeof ingestedBy>;
