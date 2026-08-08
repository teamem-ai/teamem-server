/**
 * Per-team LLM resolution — makes the provider/key/model a team saves in the
 * portal (/settings/llm → llm_config) actually drive compilation.
 *
 * The compile worker previously used a single LLM client built from
 * environment variables, so the DB config the settings page wrote was never
 * consumed. This resolver is called per job with the job's teamId and returns
 * the LLM + embedding clients to compile with:
 *
 *   1. The team's stored BYO config (provider + decrypted key + chosen model)
 *      takes precedence — this is what "choose a model" relies on.
 *   2. Otherwise the environment-configured provider (M0/M1 behavior).
 *   3. Otherwise null → the caller fails the job with `no_llm_provider`.
 *
 * `custom` providers are resolved from env only: llm_config has no base-URL
 * column, so a custom endpoint cannot be reconstructed from the DB. The chosen
 * model is passed as `defaultModel`; a null model falls back to the provider's
 * DEFAULT_MODELS in the factory.
 */
import type { AppDb } from '../db/client.js';
import type { LlmClient } from './types.js';
import type { EmbeddingClient } from './embedding/port.js';
import type { ResolvedLlmConfig } from '../config/llm.js';
import { createLlmClient } from './factory.js';
import { createEmbeddingClient } from './embedding/factory.js';
import { decryptApiKey } from './encrypt-key.js';

export interface ResolvedTeamLlm {
  llm: LlmClient;
  embeddingClient: EmbeddingClient | null;
}

/** Resolve the LLM/embedding clients for a team's compile job, or null when no
 *  provider is available anywhere. */
export type TeamLlmResolver = (teamId: string) => Promise<ResolvedTeamLlm | null>;

/** Map a stored provider name + key to a BYO config. Returns null for `custom`
 *  (needs a base URL not stored in llm_config) and unknown providers, so the
 *  caller falls back to env. */
function dbProviderToConfig(
  provider: string,
  apiKey: string,
): ResolvedLlmConfig | null {
  switch (provider) {
    case 'anthropic':
      return { kind: 'claude', apiKey };
    case 'openai':
      return { kind: 'openai', apiKey };
    case 'openrouter':
      return { kind: 'openrouter', apiKey };
    default:
      return null;
  }
}

/** Build the client pair from a resolved config + chosen model (null → the
 *  factory's per-provider default). Passing the model as `defaultModel` is what
 *  makes the user's choice reach the provider call. */
function defaultBuild(
  config: ResolvedLlmConfig,
  model: string | null,
): ResolvedTeamLlm {
  const llm = createLlmClient(config, model ? { defaultModel: model } : {});
  const embeddingClient = createEmbeddingClient(config);
  return { llm, embeddingClient };
}

/**
 * Build a resolver over a database handle and an optional environment
 * fallback provider (the config M0/M1 read from env).
 *
 * `build` is injectable for tests (mirrors the fetch-injection seam elsewhere)
 * so the config + model handed to the client factory can be asserted without
 * touching the network.
 */
export function createTeamLlmResolver(deps: {
  db: AppDb;
  fallback?: ResolvedLlmConfig;
  build?: (config: ResolvedLlmConfig, model: string | null) => ResolvedTeamLlm;
}): TeamLlmResolver {
  const { db, fallback } = deps;
  const build = deps.build ?? defaultBuild;

  return async (teamId: string): Promise<ResolvedTeamLlm | null> => {
    // 1. Team's saved BYO config takes precedence.
    try {
      const res = await db.$client.query(
        `SELECT provider, model, api_key_encrypted
           FROM llm_config
          WHERE team_id = $1
          LIMIT 1`,
        [teamId],
      );
      const row = res.rows[0] as
        | { provider: string; model: string | null; api_key_encrypted: string | null }
        | undefined;
      if (row?.api_key_encrypted) {
        const apiKey = decryptApiKey(row.api_key_encrypted);
        if (apiKey) {
          const config = dbProviderToConfig(row.provider, apiKey);
          if (config) {
            return build(config, row.model ?? null);
          }
          // custom/unknown → fall through to env fallback.
        }
      }
    } catch {
      // A DB/decrypt hiccup must not fail the job for a reason unrelated to
      // the team's real config — fall back to env instead.
    }

    // 2. Environment-configured provider (M0/M1 behavior).
    if (fallback) {
      return build(fallback, null);
    }

    // 3. No provider anywhere.
    return null;
  };
}
