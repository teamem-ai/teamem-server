import { isIP } from 'node:net';
import { z } from 'zod';

import type { ResolvedLlmConfig } from './llm.js';

export const DEFAULT_SERVER_HOST = '0.0.0.0';
export const DEFAULT_SERVER_PORT = 8080;

type Environment = Readonly<Record<string, string | undefined>>;

function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function isHostnameOrIp(value: string): boolean {
  if (isIP(value) !== 0) return true;
  if (value.length > 253) return false;

  return value.split('.').every((label) =>
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
  );
}

const requiredPostgresUrl = z
  .string()
  .trim()
  .min(1, 'DATABASE_URL is required')
  .pipe(z.url('DATABASE_URL must be a valid URL'))
  .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
    message: 'DATABASE_URL must use the postgres or postgresql scheme',
  })
  .refine((value) => new URL(value).hostname.length > 0, {
    message: 'DATABASE_URL must include a database host',
  });

const serverHost = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine(isHostnameOrIp, 'TEAMEM_HOST must be a hostname or IP address')
    .default(DEFAULT_SERVER_HOST),
);

const serverPort = z.preprocess((value) => {
  const normalized = blankToUndefined(value);
  if (normalized === undefined) return DEFAULT_SERVER_PORT;
  if (typeof normalized !== 'string' || !/^[1-9]\d*$/.test(normalized)) return normalized;
  return Number(normalized);
}, z.number().int().min(1).max(65_535));

const strictBoolean = z.preprocess((value) => {
  const normalized = blankToUndefined(value);
  if (normalized === undefined) return false;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return normalized;
}, z.boolean());

const optionalSecret = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());
const optionalGithubId = z.preprocess(
  blankToUndefined,
  z.string().trim().regex(/^[1-9]\d*$/, 'GitHub IDs must be positive decimal integers').optional(),
);
const optionalPrivateKey = z.preprocess(
  blankToUndefined,
  z.string().trim().min(1).optional(),
);
const optionalGithubClientId = z.preprocess(
  blankToUndefined,
  z.string().trim().min(1).optional(),
);
const optionalGithubClientSecret = z.preprocess(
  blankToUndefined,
  z.string().trim().min(1).optional(),
);
const optionalHttpUrl = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .pipe(z.url('TEAMEM_OPENAI_COMPAT_BASE_URL must be a valid URL'))
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
      message: 'TEAMEM_OPENAI_COMPAT_BASE_URL must use http or https',
    })
    .optional(),
);

const optionalBaseUrl = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .pipe(z.url('TEAMEM_BASE_URL must be a valid URL'))
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
      message: 'TEAMEM_BASE_URL must use http or https',
    })
    .optional(),
);

/**
 * Accept `TEAMEM_DATABASE_URL` as an alias for `DATABASE_URL`.
 *
 * Every other variable carries the `TEAMEM_` prefix (AGENTS.md §4), and the
 * bootstrap command already reads `TEAMEM_DATABASE_URL ?? DATABASE_URL`. This
 * parser did not, so a caller that set only the prefixed form — which the QA
 * scripts do — got half a working command: bootstrap connected to the right
 * database and then failed inside this parser with a confusing
 * "DATABASE_URL: expected string, received undefined".
 *
 * The precedence matches bootstrap's so the two cannot disagree about which
 * database is in use. Deployments that set only `DATABASE_URL` (docker
 * compose) are unaffected.
 */
function normalizeDatabaseUrl(environment: Environment): Environment {
  const prefixed = environment['TEAMEM_DATABASE_URL'];
  if (prefixed === undefined) return environment;
  return { ...environment, DATABASE_URL: prefixed };
}

const rawServerEnvSchema = z
  .object({
    DATABASE_URL: requiredPostgresUrl,
    TEAMEM_HOST: serverHost,
    TEAMEM_PORT: serverPort,
    TEAMEM_ALL_IN_ONE: strictBoolean,
    TEAMEM_GITHUB_WEBHOOK_SECRET: optionalSecret,
    TEAMEM_GITHUB_APP_ID: optionalGithubId,
    TEAMEM_GITHUB_INSTALLATION_ID: optionalGithubId,
    TEAMEM_GITHUB_PRIVATE_KEY: optionalPrivateKey,
    TEAMEM_GITHUB_OAUTH_CLIENT_ID: optionalGithubClientId,
    TEAMEM_GITHUB_OAUTH_CLIENT_SECRET: optionalGithubClientSecret,
    TEAMEM_ANTHROPIC_API_KEY: optionalSecret,
    TEAMEM_OPENAI_API_KEY: optionalSecret,
    TEAMEM_OPENROUTER_API_KEY: optionalSecret,
    TEAMEM_BASE_URL: optionalBaseUrl,
    TEAMEM_OPENAI_COMPAT_BASE_URL: optionalHttpUrl,
    TEAMEM_OPENAI_COMPAT_API_KEY: optionalSecret,
  })
  .superRefine((env, context) => {
    const hasCustomBaseUrl = env.TEAMEM_OPENAI_COMPAT_BASE_URL !== undefined;
    const hasCustomApiKey = env.TEAMEM_OPENAI_COMPAT_API_KEY !== undefined;

    if (hasCustomBaseUrl !== hasCustomApiKey) {
      context.addIssue({
        code: 'custom',
        path: [
          hasCustomBaseUrl
            ? 'TEAMEM_OPENAI_COMPAT_API_KEY'
            : 'TEAMEM_OPENAI_COMPAT_BASE_URL',
        ],
        message:
          'TEAMEM_OPENAI_COMPAT_BASE_URL and TEAMEM_OPENAI_COMPAT_API_KEY must be configured together',
      });
    }

    const hasOauthClientId = env.TEAMEM_GITHUB_OAUTH_CLIENT_ID !== undefined;
    const hasOauthClientSecret = env.TEAMEM_GITHUB_OAUTH_CLIENT_SECRET !== undefined;

    if (hasOauthClientId !== hasOauthClientSecret) {
      context.addIssue({
        code: 'custom',
        path: [
          hasOauthClientId
            ? 'TEAMEM_GITHUB_OAUTH_CLIENT_SECRET'
            : 'TEAMEM_GITHUB_OAUTH_CLIENT_ID',
        ],
        message:
          'TEAMEM_GITHUB_OAUTH_CLIENT_ID and TEAMEM_GITHUB_OAUTH_CLIENT_SECRET must be configured together (they belong to the same GitHub App)',
      });
    }
  });

export interface GithubEnvironment {
  webhookSecret?: string;
  appId?: string;
  installationId?: string;
  /** RSA private key in PEM format for GitHub App authentication. */
  privateKey?: string;
  /** OAuth Client ID from the same GitHub App (used for user login). */
  oauthClientId?: string;
  /** OAuth Client Secret from the same GitHub App (used for user login). */
  oauthClientSecret?: string;
}

export interface ServerEnvironment {
  databaseUrl: string;
  host: string;
  port: number;
  /** Public base URL for OAuth redirect URI construction. */
  baseUrl: string;
  allInOne: boolean;
  github?: GithubEnvironment;
  /**
   * True when the single GitHub App is fully configured for both
   * OAuth login AND webhook/installation ingestion. Used by health
   * checks and the frontend to signal whether GitHub login is available.
   */
  githubAppConfigured: boolean;
  llmProviders: ResolvedLlmConfig[];
}



/**
 * Parse deployment configuration from environment variables. Only explicitly
 * named TEAMEM_ provider keys are considered; ambient bare provider variables
 * are intentionally ignored.
 */
export function parseServerEnv(environment: Environment = process.env): ServerEnvironment {
  const env = rawServerEnvSchema.parse(normalizeDatabaseUrl(environment));
  const githubConfigured =
    env.TEAMEM_GITHUB_WEBHOOK_SECRET !== undefined ||
    env.TEAMEM_GITHUB_APP_ID !== undefined ||
    env.TEAMEM_GITHUB_INSTALLATION_ID !== undefined ||
    env.TEAMEM_GITHUB_PRIVATE_KEY !== undefined ||
    env.TEAMEM_GITHUB_OAUTH_CLIENT_ID !== undefined ||
    env.TEAMEM_GITHUB_OAUTH_CLIENT_SECRET !== undefined;

  /**
   * The GitHub App is considered fully configured when all five
   * credentials are present: App ID, private key, webhook secret,
   * OAuth client ID, and OAuth client secret. Installation ID can be
   * provided later (it is derivable from the webhook event).
   */
  const githubAppConfigured =
    env.TEAMEM_GITHUB_APP_ID !== undefined &&
    env.TEAMEM_GITHUB_PRIVATE_KEY !== undefined &&
    env.TEAMEM_GITHUB_WEBHOOK_SECRET !== undefined &&
    env.TEAMEM_GITHUB_OAUTH_CLIENT_ID !== undefined &&
    env.TEAMEM_GITHUB_OAUTH_CLIENT_SECRET !== undefined;

  const llmProviders: ResolvedLlmConfig[] = [];

  if (env.TEAMEM_ANTHROPIC_API_KEY !== undefined) {
    llmProviders.push({ kind: 'claude', apiKey: env.TEAMEM_ANTHROPIC_API_KEY });
  }
  if (env.TEAMEM_OPENAI_API_KEY !== undefined) {
    llmProviders.push({ kind: 'openai', apiKey: env.TEAMEM_OPENAI_API_KEY });
  }
  if (env.TEAMEM_OPENROUTER_API_KEY !== undefined) {
    llmProviders.push({ kind: 'openrouter', apiKey: env.TEAMEM_OPENROUTER_API_KEY });
  }
  if (
    env.TEAMEM_OPENAI_COMPAT_BASE_URL !== undefined &&
    env.TEAMEM_OPENAI_COMPAT_API_KEY !== undefined
  ) {
    llmProviders.push({
      kind: 'custom',
      baseUrl: env.TEAMEM_OPENAI_COMPAT_BASE_URL,
      apiKey: env.TEAMEM_OPENAI_COMPAT_API_KEY,
    });
  }

  const baseUrl = env.TEAMEM_BASE_URL ?? `http://localhost:${env.TEAMEM_PORT}`;

  return {
    databaseUrl: env.DATABASE_URL,
    host: env.TEAMEM_HOST,
    port: env.TEAMEM_PORT,
    baseUrl,
    allInOne: env.TEAMEM_ALL_IN_ONE,
    github: githubConfigured
      ? {
          webhookSecret: env.TEAMEM_GITHUB_WEBHOOK_SECRET,
          appId: env.TEAMEM_GITHUB_APP_ID,
          installationId: env.TEAMEM_GITHUB_INSTALLATION_ID,
          privateKey: env.TEAMEM_GITHUB_PRIVATE_KEY,
          oauthClientId: env.TEAMEM_GITHUB_OAUTH_CLIENT_ID,
          oauthClientSecret: env.TEAMEM_GITHUB_OAUTH_CLIENT_SECRET,
        }
      : undefined,
    githubAppConfigured,
    llmProviders,
  };
}

export const parseEnv = parseServerEnv;
