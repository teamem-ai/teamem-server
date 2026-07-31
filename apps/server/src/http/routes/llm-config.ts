/**
 * LLM Configuration Routes (DUA-237).
 *
 * Web-session-authenticated routes for LLM provider management:
 *   GET    /v1/teams/:teamId/llm       → read current LLM config & status
 *   PUT    /v1/teams/:teamId/llm       → update LLM provider + API key
 *   POST   /v1/teams/:teamId/llm/test  → test connection to provider
 *
 * Admin+ only. BYO LLM keys are stored AES-256-GCM encrypted at rest
 * (reversible, because the server needs the plaintext to call providers).
 * The encryption key is TEAMEM_LLM_ENCRYPTION_KEY (64 hex chars).
 */
import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import * as schema from '../../db/schema.js';
import {
  requireWebSession,
  requireTeamMembership,
  getWebSession,
} from '../session.js';
import { requireRole } from '../../auth/rbac.js';
import {
  InvalidRequestError,
  InternalError,
  REQUEST_ID_KEY,
} from '../errors.js';
import {
  llmConfigRequest as llmConfigRequestSchema,
  type LlmConfigResponse,
  type LlmProvider,
} from '@teamem/schema';
import { encryptApiKey, decryptApiKey } from '../../llm/encrypt-key.js';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface LlmConfigDeps {
  db: AppDb;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function rowToResponse(
  row: typeof schema.llmConfig.$inferSelect | undefined,
): LlmConfigResponse {
  if (!row) {
    return {
      provider: null,
      hasKey: false,
      lastTest: null,
      semanticRetrieval: {
        available: false,
        mode: 'fts-only',
        reason: 'No LLM provider configured',
      },
    };
  }

  return {
    provider: row.provider as LlmProvider,
    hasKey: row.apiKeyEncrypted !== null,
    lastTest: row.lastTestAt
      ? {
          ok: row.lastTestOk ?? false,
          latencyMs: row.lastTestLatencyMs ?? null,
          testedAt: row.lastTestAt.toISOString(),
        }
      : null,
    semanticRetrieval: {
      available: row.embeddingAvailable,
      mode: row.embeddingAvailable ? 'vector' : 'fts-only',
      reason: row.embeddingAvailable
        ? null
        : 'Your LLM provider has no embedding API',
    },
  };
}

/** Test URLs for lightweight model listing per provider. */
const PROVIDER_TEST_URLS: Record<LlmProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/models?limit=1',
  openai: 'https://api.openai.com/v1/models?limit=1',
  openrouter: 'https://openrouter.ai/api/v1/models?limit=1',
  // Base URL is the /v1 root (per env.ts). The test function appends /models.
  custom: process.env['TEAMEM_OPENAI_COMPAT_BASE_URL'] ?? '',
};

async function testProviderConnection(
  provider: LlmProvider,
  apiKey: string,
): Promise<{ ok: boolean; latencyMs: number | null }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    let url = PROVIDER_TEST_URLS[provider];
    if (provider === 'custom' && url) {
      // Base URL already points at the /v1 root (per env.ts). Append /models only.
      url = url.replace(/\/$/, '') + '/models?limit=1';
    }
    if (!url) {
      // For custom endpoint without a configured base URL, we can't test
      return { ok: false, latencyMs: null };
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await fetch(url, { headers, signal: controller.signal });
    const latencyMs = Date.now() - start;

    // Only HTTP 200 means the key was accepted. 401 means the endpoint exists
    // but the key is invalid, so we report it as NOT ok.
    return { ok: res.ok, latencyMs };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Route builder ───────────────────────────────────────────────────────────

export function buildLlmConfigRoutes(deps: LlmConfigDeps): Hono {
  const { db } = deps;
  const routes = new Hono();

  routes.use('/v1/teams/:teamId/llm', requireWebSession(db));
  routes.use('/v1/teams/:teamId/llm', requireTeamMembership(db));
  routes.use('/v1/teams/:teamId/llm/test', requireWebSession(db));
  routes.use('/v1/teams/:teamId/llm/test', requireTeamMembership(db));

  // ── GET /v1/teams/:teamId/llm ────────────────────────────────────────
  routes.get('/v1/teams/:teamId/llm', async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);

    try {
      const rows = await db
        .select()
        .from(schema.llmConfig)
        .where(eq(schema.llmConfig.teamId, ws.scope.teamId))
        .limit(1);

      const response = rowToResponse(rows[0]);
      return c.json({ requestId, data: response });
    } catch (err) {
      throw new InternalError('Failed to read LLM configuration', { cause: err });
    }
  });

  // ── PUT /v1/teams/:teamId/llm ────────────────────────────────────────
  routes.put(
    '/v1/teams/:teamId/llm',
    requireRole('admin'),
    async (c: Context) => {
      const requestId = c.get(REQUEST_ID_KEY) as string;
      const ws = getWebSession(c);
      const teamId = ws.scope.teamId;

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new InvalidRequestError('Request body is not valid JSON');
      }

      const parsed = llmConfigRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new InvalidRequestError('Request body validation failed', {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        } as unknown as Record<string, unknown>);
      }

      const { provider, apiKey } = parsed.data;

      // Encrypt the API key at rest (AES-256-GCM). Throws if
      // TEAMEM_LLM_ENCRYPTION_KEY is not configured.
      let apiKeyEncrypted: string;
      try {
        apiKeyEncrypted = encryptApiKey(apiKey);
      } catch (err) {
        throw new InternalError(
          'Server encryption key not configured — cannot store LLM provider key',
          { cause: err },
        );
      }

      const embeddingAvailable = provider !== 'anthropic';

      try {
        await db
          .insert(schema.llmConfig)
          .values({
            teamId,
            provider,
            apiKeyEncrypted,
            embeddingAvailable,
          })
          .onConflictDoUpdate({
            target: schema.llmConfig.teamId,
            set: {
              provider,
              apiKeyEncrypted,
              embeddingAvailable,
              updatedAt: new Date(),
            },
          });

        console.info(
          JSON.stringify({
            event: 'llm_config_updated',
            requestId,
            teamId,
            provider,
            updatedByUserId: ws.userId,
          }),
        );

        return c.json({ requestId, data: { ok: true } });
      } catch (err) {
        throw new InternalError('Failed to update LLM configuration', {
          cause: err,
        });
      }
    },
  );

  // ── POST /v1/teams/:teamId/llm/test ──────────────────────────────────
  routes.post(
    '/v1/teams/:teamId/llm/test',
    requireRole('admin'),
    async (c: Context) => {
      const requestId = c.get(REQUEST_ID_KEY) as string;
      const ws = getWebSession(c);
      const teamId = ws.scope.teamId;

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new InvalidRequestError('Request body is not valid JSON');
      }

      const { apiKey, provider } = body as {
        apiKey?: string;
        provider?: string;
      };
      if (!apiKey || typeof apiKey !== 'string') {
        throw new InvalidRequestError('apiKey is required');
      }

      // Use provided provider or fall back to stored config
      let testProvider: LlmProvider = (provider as LlmProvider) ?? 'openai';
      if (!['anthropic', 'openai', 'openrouter', 'custom'].includes(testProvider)) {
        testProvider = 'openai';
      }

      // If no apiKey provided in body, try to decrypt the stored key
      let testKey = apiKey;
      if (testKey === '__STORED__') {
        try {
          const rows = await db
            .select({ encrypted: schema.llmConfig.apiKeyEncrypted })
            .from(schema.llmConfig)
            .where(eq(schema.llmConfig.teamId, teamId))
            .limit(1);
          if (rows[0]?.encrypted) {
            const decrypted = decryptApiKey(rows[0].encrypted);
            if (decrypted) testKey = decrypted;
          }
        } catch {
          // Fall through — use the provided key or fail
        }
      }

      const result = await testProviderConnection(testProvider, testKey);

      // Update last_test results
      try {
        await db
          .update(schema.llmConfig)
          .set({
            lastTestOk: result.ok,
            lastTestLatencyMs: result.latencyMs,
            lastTestAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.llmConfig.teamId, teamId));
      } catch {
        // Best-effort
      }

      return c.json({ requestId, data: result });
    },
  );

  return routes;
}
