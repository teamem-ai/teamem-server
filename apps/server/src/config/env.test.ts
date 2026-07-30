import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerEnv,
} from './env.js';

const DATABASE_URL = 'postgres://teamem:secret@localhost:5432/teamem';

describe('parseServerEnv', () => {
  it('parses the required database URL and applies server defaults', () => {
    expect(parseServerEnv({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      baseUrl: `http://localhost:${DEFAULT_SERVER_PORT}`,
      allInOne: false,
      github: undefined,
      githubAppConfigured: false,
      llmProviders: [],
    });
  });

  it('parses listener, all-in-one, GitHub, and every TEAMEM_ provider setting', () => {
    expect(
      parseServerEnv({
        DATABASE_URL: DATABASE_URL.replace('postgres:', 'postgresql:'),
        TEAMEM_HOST: '::1',
        TEAMEM_PORT: '3000',
        TEAMEM_ALL_IN_ONE: 'true',
        TEAMEM_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
        TEAMEM_GITHUB_APP_ID: '123456',
        TEAMEM_GITHUB_INSTALLATION_ID: '9876543210',
        TEAMEM_GITHUB_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----',
        TEAMEM_GITHUB_OAUTH_CLIENT_ID: 'Iv1.abcdef12345678',
        TEAMEM_GITHUB_OAUTH_CLIENT_SECRET: 'github_oauth_secret_hex_value',
        TEAMEM_ANTHROPIC_API_KEY: 'anthropic-key',
        TEAMEM_OPENAI_API_KEY: 'openai-key',
        TEAMEM_OPENROUTER_API_KEY: 'openrouter-key',
        TEAMEM_OPENAI_COMPAT_BASE_URL: 'https://llm.example.test/v1',
        TEAMEM_OPENAI_COMPAT_API_KEY: 'custom-key',
      }),
    ).toEqual({
      databaseUrl: DATABASE_URL.replace('postgres:', 'postgresql:'),
      host: '::1',
      port: 3000,
      baseUrl: 'http://localhost:3000',
      allInOne: true,
      github: {
        webhookSecret: 'webhook-secret',
        appId: '123456',
        installationId: '9876543210',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----',
        oauthClientId: 'Iv1.abcdef12345678',
        oauthClientSecret: 'github_oauth_secret_hex_value',
      },
      githubAppConfigured: true,
      llmProviders: [
        { kind: 'claude', apiKey: 'anthropic-key' },
        { kind: 'openai', apiKey: 'openai-key' },
        { kind: 'openrouter', apiKey: 'openrouter-key' },
        {
          kind: 'custom',
          baseUrl: 'https://llm.example.test/v1',
          apiKey: 'custom-key',
        },
      ],
    });
  });

  it('accepts TEAMEM_DATABASE_URL as an alias for DATABASE_URL', () => {
    // The bootstrap command reads TEAMEM_DATABASE_URL, and the QA scripts pass
    // it. Without this the command connected to the right database and then
    // failed inside this parser complaining that DATABASE_URL was undefined.
    const env = parseServerEnv({
      TEAMEM_DATABASE_URL: 'postgres://user:pw@localhost:5432/teamem',
    });
    expect(env.databaseUrl).toBe('postgres://user:pw@localhost:5432/teamem');
  });

  it('prefers TEAMEM_DATABASE_URL over DATABASE_URL so bootstrap cannot disagree', () => {
    // bootstrap.ts resolves `TEAMEM_DATABASE_URL ?? DATABASE_URL`; the two must
    // not pick different databases when both are present.
    const env = parseServerEnv({
      DATABASE_URL: 'postgres://user:pw@localhost:5432/legacy',
      TEAMEM_DATABASE_URL: 'postgres://user:pw@localhost:5432/prefixed',
    });
    expect(env.databaseUrl).toBe('postgres://user:pw@localhost:5432/prefixed');
  });

  it('still rejects when neither database URL is set', () => {
    expect(() => parseServerEnv({})).toThrow();
  });


  it.each([
    ['1', 1],
    ['65535', 65_535],
  ])('accepts boundary listener port %s', (port, expected) => {
    expect(parseServerEnv({ DATABASE_URL, TEAMEM_PORT: port }).port).toBe(expected);
  });

  it.each([
    { databaseUrl: undefined, caseName: 'missing' },
    { databaseUrl: '', caseName: 'empty' },
    { databaseUrl: 'not a URL', caseName: 'malformed' },
    { databaseUrl: 'postgres:teamem', caseName: 'hostless' },
    { databaseUrl: 'https://db.example.test/teamem', caseName: 'wrong scheme' },
  ])('rejects a $caseName database URL', ({ databaseUrl }) => {
    expect(() => parseServerEnv({ DATABASE_URL: databaseUrl })).toThrow();
  });

  it.each(['0', '65536', '-1', '1.5', '1e3', ' 8080', '08080', 'abc'])(
    'rejects invalid or non-canonical port %j',
    (port) => {
      expect(() => parseServerEnv({ DATABASE_URL, TEAMEM_PORT: port })).toThrow();
    },
  );

  it.each(['TRUE', 'False', '1', 'yes', ' true '])(
    'rejects non-literal all-in-one boolean %j',
    (allInOne) => {
      expect(() =>
        parseServerEnv({ DATABASE_URL, TEAMEM_ALL_IN_ONE: allInOne }),
      ).toThrow();
    },
  );

  it.each(['https://localhost', 'localhost:8080', 'bad host', '-invalid.example'])(
    'rejects invalid listener host %j',
    (host) => {
      expect(() => parseServerEnv({ DATABASE_URL, TEAMEM_HOST: host })).toThrow();
    },
  );

  it.each([
    {
      TEAMEM_OPENAI_COMPAT_BASE_URL: 'https://llm.example.test/v1',
    },
    {
      TEAMEM_OPENAI_COMPAT_API_KEY: 'custom-key',
    },
  ])('rejects incomplete custom provider configuration', (customEnvironment) => {
    expect(() => parseServerEnv({ DATABASE_URL, ...customEnvironment })).toThrow(
      'must be configured together',
    );
  });

  it.each(['not a URL', 'ftp://llm.example.test/v1'])(
    'rejects invalid custom provider URL %j',
    (baseUrl) => {
      expect(() =>
        parseServerEnv({
          DATABASE_URL,
          TEAMEM_OPENAI_COMPAT_BASE_URL: baseUrl,
          TEAMEM_OPENAI_COMPAT_API_KEY: 'custom-key',
        }),
      ).toThrow();
    },
  );

  it.each(['0', '-1', '1.5', 'not-an-id'])('rejects invalid GitHub numeric ID %j', (id) => {
    expect(() => parseServerEnv({ DATABASE_URL, TEAMEM_GITHUB_APP_ID: id })).toThrow();
  });

  it('treats blank optional values as unconfigured', () => {
    expect(
      parseServerEnv({
        DATABASE_URL,
        TEAMEM_HOST: ' ',
        TEAMEM_PORT: '',
        TEAMEM_ALL_IN_ONE: '',
        TEAMEM_GITHUB_WEBHOOK_SECRET: '',
        TEAMEM_ANTHROPIC_API_KEY: ' ',
        TEAMEM_OPENAI_COMPAT_BASE_URL: '',
        TEAMEM_OPENAI_COMPAT_API_KEY: '',
      }),
    ).toMatchObject({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      allInOne: false,
      github: undefined,
      githubAppConfigured: false,
      llmProviders: [],
    });
  });

  // ── GitHub OAuth co-requirement validation ────────────────────────────

  it('accepts the full GitHub App (webhook + OAuth) configuration', () => {
    const env = parseServerEnv({
      DATABASE_URL,
      TEAMEM_GITHUB_APP_ID: '123456',
      TEAMEM_GITHUB_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      TEAMEM_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
      TEAMEM_GITHUB_OAUTH_CLIENT_ID: 'Iv1.abcdef12345678',
      TEAMEM_GITHUB_OAUTH_CLIENT_SECRET: 'github_oauth_secret',
    });
    expect(env.githubAppConfigured).toBe(true);
    expect(env.github?.oauthClientId).toBe('Iv1.abcdef12345678');
    expect(env.github?.oauthClientSecret).toBe('github_oauth_secret');
  });

  it('reports githubAppConfigured as false when only webhook credentials are set', () => {
    const env = parseServerEnv({
      DATABASE_URL,
      TEAMEM_GITHUB_APP_ID: '123456',
      TEAMEM_GITHUB_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      TEAMEM_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    });
    expect(env.githubAppConfigured).toBe(false);
    expect(env.github).toBeDefined();
  });

  it('reports githubAppConfigured as false when only OAuth credentials are set', () => {
    const env = parseServerEnv({
      DATABASE_URL,
      TEAMEM_GITHUB_OAUTH_CLIENT_ID: 'Iv1.abcdef12345678',
      TEAMEM_GITHUB_OAUTH_CLIENT_SECRET: 'github_oauth_secret',
    });
    expect(env.githubAppConfigured).toBe(false);
    expect(env.github).toBeDefined();
  });

  it('reports githubAppConfigured as false with no GitHub config at all', () => {
    const env = parseServerEnv({ DATABASE_URL });
    expect(env.githubAppConfigured).toBe(false);
    expect(env.github).toBeUndefined();
  });

  it.each([
    { clientId: 'Iv1.abc', clientSecret: undefined, missing: 'TEAMEM_GITHUB_OAUTH_CLIENT_SECRET' },
    { clientId: undefined, clientSecret: 'secret', missing: 'TEAMEM_GITHUB_OAUTH_CLIENT_ID' },
  ])('rejects when only half of the OAuth pair is configured ($missing missing)', ({ clientId, clientSecret }) => {
    expect(() =>
      parseServerEnv({
        DATABASE_URL,
        TEAMEM_GITHUB_OAUTH_CLIENT_ID: clientId,
        TEAMEM_GITHUB_OAUTH_CLIENT_SECRET: clientSecret,
      }),
    ).toThrow('must be configured together');
  });

  it('accepts OAuth credentials alongside partial webhook config (still not fully configured)', () => {
    const env = parseServerEnv({
      DATABASE_URL,
      TEAMEM_GITHUB_OAUTH_CLIENT_ID: 'Iv1.abcdef12345678',
      TEAMEM_GITHUB_OAUTH_CLIENT_SECRET: 'github_oauth_secret',
      TEAMEM_GITHUB_APP_ID: '123456',
    });
    // OAuth pair is valid, webhook parts are individually optional.
    // githubAppConfigured is false because the full App isn't wired.
    expect(env.githubAppConfigured).toBe(false);
    expect(env.github?.oauthClientId).toBe('Iv1.abcdef12345678');
    expect(env.github?.oauthClientSecret).toBe('github_oauth_secret');
    expect(env.github?.appId).toBe('123456');
  });

  // OAuth values are secrets; must never appear in error messages.
  it('does not leak OAuth secret values in validation error messages', () => {
    expect(() =>
      parseServerEnv({
        DATABASE_URL,
        TEAMEM_GITHUB_OAUTH_CLIENT_ID: 'Iv1.sensitive',
      }),
    ).toThrow();
    try {
      parseServerEnv({
        DATABASE_URL,
        TEAMEM_GITHUB_OAUTH_CLIENT_ID: 'Iv1.sensitive',
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The OAuth secret value should not appear; only the key name.
      expect(message).not.toContain('sensitive');
      // Must mention the missing companion key.
      expect(message).toContain('TEAMEM_GITHUB_OAUTH_CLIENT_SECRET');
    }
  });

  // ── Blank-handling for OAuth fields ───────────────────────────────────

  it('treats blank OAuth values as unconfigured (no half-pair error)', () => {
    const env = parseServerEnv({
      DATABASE_URL,
      TEAMEM_GITHUB_OAUTH_CLIENT_ID: '',
      TEAMEM_GITHUB_OAUTH_CLIENT_SECRET: '  ',
    });
    expect(env.githubAppConfigured).toBe(false);
    expect(env.github).toBeUndefined();
  });

  it('never reads bare provider API key variables', () => {
    const parsed = parseServerEnv({
      DATABASE_URL,
      ANTHROPIC_API_KEY: 'ambient-anthropic-secret',
      OPENAI_API_KEY: 'ambient-openai-secret',
      OPENROUTER_API_KEY: 'ambient-openrouter-secret',
    });

    expect(parsed.llmProviders).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('ambient-');
  });
});
