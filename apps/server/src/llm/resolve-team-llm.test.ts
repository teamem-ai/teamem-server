/**
 * Per-team LLM resolution — the logic that makes a team's saved provider/key/
 * model actually drive compilation. Uses a stubbed pg client and a real
 * encrypt/decrypt round-trip; the client factory is injected so the config +
 * model handed to it can be asserted without any network call.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTeamLlmResolver, type ResolvedTeamLlm } from './resolve-team-llm.js';
import { encryptApiKey } from './encrypt-key.js';
import type { ResolvedLlmConfig } from '../config/llm.js';
import type { AppDb } from '../db/client.js';

// A valid 64-hex (32-byte) key so encrypt/decrypt work in-process.
const ENC_KEY = 'a'.repeat(64);

beforeAll(() => {
  process.env['TEAMEM_LLM_ENCRYPTION_KEY'] = ENC_KEY;
});

/** A fake AppDb whose $client.query returns a single preset row (or none). */
function fakeDb(row: Record<string, unknown> | undefined): AppDb {
  return {
    $client: {
      query: vi.fn(async () => ({ rows: row ? [row] : [] })),
    },
  } as unknown as AppDb;
}

const stub: ResolvedTeamLlm = {
  llm: { structured: vi.fn() } as unknown as ResolvedTeamLlm['llm'],
  embeddingClient: null,
};

describe('createTeamLlmResolver', () => {
  it("uses the team's saved provider, decrypted key, and chosen model", async () => {
    const row = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      api_key_encrypted: encryptApiKey('sk-team-key'),
    };
    const build = vi.fn<(config: ResolvedLlmConfig, model: string | null) => ResolvedTeamLlm>(() => stub);
    const resolve = createTeamLlmResolver({ db: fakeDb(row), build });

    const result = await resolve('team_x');

    expect(result).toBe(stub);
    expect(build).toHaveBeenCalledTimes(1);
    const [config, model] = build.mock.calls[0]!;
    expect(config).toEqual({ kind: 'openai', apiKey: 'sk-team-key' });
    expect(model).toBe('gpt-4o-mini');
  });

  it('passes a null model through (factory default) when none is chosen', async () => {
    const row = {
      provider: 'anthropic',
      model: null,
      api_key_encrypted: encryptApiKey('sk-ant'),
    };
    const build = vi.fn<(config: ResolvedLlmConfig, model: string | null) => ResolvedTeamLlm>(() => stub);
    const resolve = createTeamLlmResolver({ db: fakeDb(row), build });

    await resolve('team_x');

    const [config, model] = build.mock.calls[0]!;
    expect(config).toEqual({ kind: 'claude', apiKey: 'sk-ant' });
    expect(model).toBeNull();
  });

  it('falls back to the env provider when the team has no saved config', async () => {
    const fallback: ResolvedLlmConfig = { kind: 'openai', apiKey: 'sk-env' };
    const build = vi.fn<(config: ResolvedLlmConfig, model: string | null) => ResolvedTeamLlm>(() => stub);
    const resolve = createTeamLlmResolver({ db: fakeDb(undefined), fallback, build });

    const result = await resolve('team_x');

    expect(result).toBe(stub);
    const [config, model] = build.mock.calls[0]!;
    expect(config).toBe(fallback);
    expect(model).toBeNull();
  });

  it('falls back to env for a custom provider (no base URL stored in the DB)', async () => {
    const row = {
      provider: 'custom',
      model: 'local-model',
      api_key_encrypted: encryptApiKey('sk-custom'),
    };
    const fallback: ResolvedLlmConfig = { kind: 'openai', apiKey: 'sk-env' };
    const build = vi.fn<(config: ResolvedLlmConfig, model: string | null) => ResolvedTeamLlm>(() => stub);
    const resolve = createTeamLlmResolver({ db: fakeDb(row), fallback, build });

    await resolve('team_x');

    // Custom can't be reconstructed from the DB → env fallback is used.
    const [config] = build.mock.calls[0]!;
    expect(config).toBe(fallback);
  });

  it('returns null when there is neither a saved config nor an env fallback', async () => {
    const resolve = createTeamLlmResolver({ db: fakeDb(undefined) });
    await expect(resolve('team_x')).resolves.toBeNull();
  });
});
