/**
 * SaaS pre-provisioning seams (MVP plan §9.1). These prove the seams are
 * real and SWAPPABLE today — not that SaaS features exist (they don't yet).
 * Each test exercises the actual extension mechanism, not just its shape.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  EntitlementsService,
  SELF_HOSTED_ENTITLEMENTS,
  createSelfHostedEntitlements,
  type Entitlements,
  type EntitlementsResolver,
} from './entitlements.js';
import { resolveLlmConfig } from './config/llm.js';
import {
  getConnector,
  listConnectors,
  registerConnector,
  resetConnectors,
  type Connector,
  type NormalizedEvent,
} from './connectors/registry.js';

describe('entitlements (§9.1 mechanism 1 — injectable, not statically bound)', () => {
  // One business-code sample: it depends on EntitlementsService, nothing else.
  async function businessFeatureEnabled(
    svc: EntitlementsService,
    teamId: string,
  ): Promise<boolean> {
    return (await svc.resolve(teamId)).hostedConnectors;
  }

  it('self-hosted enables every gated capability except managed LLM', async () => {
    const svc = createSelfHostedEntitlements();
    const e = await svc.resolve('team_anything');
    expect(e).toEqual(SELF_HOSTED_ENTITLEMENTS);
    expect(e.platformManagedLlm).toBe(false); // self-hosted is always BYO key
  });

  it('the SAME business code yields different entitlements under a swapped resolver', async () => {
    // A fake billing resolver — what the SaaS composition root would inject.
    const freeTier: Entitlements = {
      hostedConnectors: false,
      sso: false,
      advancedRbac: false,
      auditExport: false,
      platformManagedLlm: false,
    };
    const billingResolver: EntitlementsResolver = async (teamId) =>
      teamId === 'team_paid'
        ? { ...freeTier, hostedConnectors: true }
        : freeTier;
    const saas = new EntitlementsService(billingResolver);

    // Same function, no source change — behavior differs purely by injection.
    expect(await businessFeatureEnabled(createSelfHostedEntitlements(), 'x')).toBe(true);
    expect(await businessFeatureEnabled(saas, 'team_free')).toBe(false);
    expect(await businessFeatureEnabled(saas, 'team_paid')).toBe(true);
  });
});

describe('LLM provider config (§9.1 mechanism 4)', () => {
  it('accepts all four BYO shapes', () => {
    expect(resolveLlmConfig({ kind: 'claude', apiKey: 'sk-x' }).kind).toBe('claude');
    expect(resolveLlmConfig({ kind: 'openai', apiKey: 'sk-x' }).kind).toBe('openai');
    expect(resolveLlmConfig({ kind: 'openrouter', apiKey: 'sk-x' }).kind).toBe('openrouter');
    expect(
      resolveLlmConfig({ kind: 'custom', baseUrl: 'http://localhost:1234/v1', apiKey: 'x' }).kind,
    ).toBe('custom');
  });

  it('rejects platform-managed in the self-hosted build (no silent no-op)', () => {
    expect(() => resolveLlmConfig({ kind: 'platform-managed' })).toThrow(
      /not available in the self-hosted build/,
    );
  });
});

describe('connector registry (§9.1 mechanism 5 — open kinds, real private event)', () => {
  afterEach(() => resetConnectors());

  it('registers, looks up, and lists connectors', () => {
    const fake: Connector = { kind: 'fake', handleWebhook: async () => [] };
    registerConnector(fake);
    expect(getConnector('fake')).toBe(fake);
    expect(listConnectors()).toHaveLength(1);
    expect(getConnector('nope')).toBeUndefined();
  });

  it('rejects duplicate registration', () => {
    const fake: Connector = { kind: 'fake', handleWebhook: async () => [] };
    registerConnector(fake);
    expect(() => registerConnector(fake)).toThrow(/already registered/);
  });

  it('a private Slack-like connector emits a real non-empty event with open kinds (no schema change)', async () => {
    // Simulates a future private @teamem/connector-slack package: its channel
    // and event identifiers are NOT in the open SourceChannel/SourceKind
    // enums, yet it produces a valid, non-empty NormalizedEvent — proving the
    // open repo needs no edit to gain it.
    const slack: Connector = {
      kind: 'slack',
      handleWebhook: async (): Promise<NormalizedEvent[]> => [
        {
          connectorKind: 'slack', // not in SourceChannel enum
          eventKind: 'message.channels', // not in SourceKind enum
          deliveryId: 'Ev123',
          itemKey: 'root',
          externalId: 'C042/p1746992',
          actor: {
            kind: 'human',
            provider: 'slack', // not in identityProvider enum
            providerUserId: 'U123',
            displayLogin: 'alice',
          },
          actorProvenance: 'webhook_verified', // resolved inside the connector (N2)
          occurredAt: '2026-07-17T00:00:00.000Z',
          occurredAtProvenance: 'provider',
          payload: { text: 'we decided to use Postgres' },
        },
      ],
    };
    registerConnector(slack);

    const events = await getConnector('slack')!.handleWebhook({
      headers: {},
      rawBody: Buffer.from(''),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.connectorKind).toBe('slack');
    expect(events[0]!.actor?.provider).toBe('slack');
    expect(events[0]!.actorProvenance).toBe('webhook_verified');
  });
});
