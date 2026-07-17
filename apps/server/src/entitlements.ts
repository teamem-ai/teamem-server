/**
 * Entitlements layer (SaaS pre-provisioning — MVP plan §9.1 mechanism 1).
 *
 * The single decision point for gated capabilities. Business code depends on
 * an EntitlementsService (injected at the composition root) and reads
 * booleans — it never contains `if (isSaaS)`. Self-hosted injects the
 * everything-enabled resolver; the SaaS build injects a billing-backed
 * resolver with the SAME signature, so business logic changes not one line.
 *
 * Injectable by construction (fixed after acceptance review): the resolver is
 * a constructor argument, not a static module binding — a previous version
 * exported `const resolveEntitlements = selfHostedResolver`, which import
 * sites would have welded in place, defeating the swap.
 */

export interface Entitlements {
  /** Managed OAuth connectors (Slack/Gmail/meetings). */
  hostedConnectors: boolean;
  /** Single sign-on. */
  sso: boolean;
  /** Advanced role-based access control beyond the four built-in roles. */
  advancedRbac: boolean;
  /** Audit log export/reporting. */
  auditExport: boolean;
  /** Platform-managed LLM (usage billed to subscription, no BYO key). */
  platformManagedLlm: boolean;
}

/** Self-hosted: every gated capability available; LLM is always BYO key. */
export const SELF_HOSTED_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({
  hostedConnectors: true,
  sso: true,
  advancedRbac: true,
  auditExport: true,
  platformManagedLlm: false, // self-hosted brings its own key; managed LLM is a SaaS concept
});

export type EntitlementsResolver = (teamId: string) => Promise<Entitlements>;

/** Self-hosted resolver: the operator runs their own instance. */
export const selfHostedResolver: EntitlementsResolver = async () =>
  SELF_HOSTED_ENTITLEMENTS;

/**
 * Injectable entitlements service. Business services receive an instance;
 * the composition root decides which resolver backs it. Swapping self-hosted
 * for a billing-backed resolver is a wiring change, not a source edit.
 */
export class EntitlementsService {
  constructor(private readonly resolver: EntitlementsResolver) {}

  resolve(teamId: string): Promise<Entitlements> {
    return this.resolver(teamId);
  }
}

/** Default wiring for the open build. */
export function createSelfHostedEntitlements(): EntitlementsService {
  return new EntitlementsService(selfHostedResolver);
}
