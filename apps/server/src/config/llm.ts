/**
 * LLM provider configuration (BYO key — deployment config, not an API DTO,
 * so it lives server-side rather than in the frozen @teamem/schema).
 *
 * Four BYO shapes plus a `platform-managed` placeholder reserved for the
 * SaaS stage (MVP plan §9.1 mechanism 4). The placeholder is declared now so
 * adding it later is not a schema change — but the self-hosted build rejects
 * it: managed billing does not exist here (see rejection in resolveLlmConfig).
 */
import { z } from 'zod';

const byoBase = { apiKey: z.string().min(1) };

export const llmProviderConfig = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('claude'), ...byoBase }),
  z.strictObject({ kind: z.literal('openai'), ...byoBase }),
  z.strictObject({ kind: z.literal('openrouter'), ...byoBase }),
  // Any OpenAI-compatible endpoint (DeepSeek, LM Studio, internal gateway) —
  // for teams that need LLM calls to stay inside their network.
  z.strictObject({
    kind: z.literal('custom'),
    baseUrl: z.url(),
    ...byoBase,
  }),
  // Reserved for SaaS: usage billed to subscription, no BYO key. Declared
  // now so it is not a future schema change; not implemented in the open
  // build.
  z.strictObject({ kind: z.literal('platform-managed') }),
]);
export type LlmProviderConfig = z.infer<typeof llmProviderConfig>;

/** Config a BYO deployment actually runs with (platform-managed excluded). */
export type ResolvedLlmConfig = Exclude<
  LlmProviderConfig,
  { kind: 'platform-managed' }
>;

/**
 * Validate and narrow a provider config for the self-hosted build. Rejects
 * `platform-managed` explicitly: it has no meaning without SaaS billing, and
 * silently accepting it would be exactly the kind of looks-configured-but-
 * does-nothing state the project forbids.
 */
export function resolveLlmConfig(raw: unknown): ResolvedLlmConfig {
  const config = llmProviderConfig.parse(raw);
  if (config.kind === 'platform-managed') {
    throw new Error(
      "LLM provider 'platform-managed' is not available in the self-hosted build; configure a BYO key (claude/openai/openrouter/custom).",
    );
  }
  return config;
}
