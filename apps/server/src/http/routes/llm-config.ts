/**
 * LLM Configuration Routes (DUA-237).
 *
 * Web-session-authenticated routes for LLM provider management:
 *   GET /v1/teams/:teamId/llm  → read current LLM config & status
 *   PUT /v1/teams/:teamId/llm  → update LLM provider + API key
 *
 * Admin+ only. The API key is stored (encrypted at rest via the db layer
 * or as configured) and NEVER returned in plaintext — only a boolean
 * `hasKey` is exposed.
 */
import { Hono, type Context } from 'hono';
import type { AppDb } from '../../db/client.js';
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
} from '@teamem/schema';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface LlmConfigDeps {
  db: AppDb;
}

// ── Route builder ───────────────────────────────────────────────────────────

export function buildLlmConfigRoutes(deps: LlmConfigDeps): Hono {
  const { db } = deps;
  const routes = new Hono();

  routes.use('/v1/teams/:teamId/llm', requireWebSession(db));
  routes.use('/v1/teams/:teamId/llm', requireTeamMembership(db));

  // ── GET /v1/teams/:teamId/llm ────────────────────────────────────────
  routes.get('/v1/teams/:teamId/llm', async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);
    const teamId = ws.scope.teamId;

    try {
      // Read stored LLM config
      const result = await db.$client.query(
        `SELECT provider, api_key_hash, last_test_ok, last_test_latency_ms,
                last_test_at, embedding_available
         FROM llm_config
         WHERE team_id = $1
         LIMIT 1`,
        [teamId],
      );

      const row = result.rows[0];

      const response: LlmConfigResponse = {
        provider: row ? (row['provider'] as LlmConfigResponse['provider']) : null,
        hasKey: row ? (row['api_key_hash'] !== null) : false,
        lastTest: row && row['last_test_at']
          ? {
              ok: row['last_test_ok'] as boolean,
              latencyMs: (row['last_test_latency_ms'] as number) ?? null,
              testedAt: (row['last_test_at'] as Date).toISOString(),
            }
          : null,
        semanticRetrieval: {
          available: row ? (row['embedding_available'] as boolean) : false,
          mode: row && row['embedding_available'] ? 'vector' : 'fts-only',
          reason: row && !row['embedding_available']
            ? 'No embedding API available with the configured provider'
            : null,
        },
      };

      return c.json({ requestId, data: response });
    } catch (err) {
      throw new InternalError('Failed to read LLM configuration', { cause: err });
    }
  });

  // ── PUT /v1/teams/:teamId/llm ────────────────────────────────────────
  routes.put('/v1/teams/:teamId/llm', requireRole('admin'), async (c: Context) => {
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

    // Providers that support embeddings: openai, openrouter, custom (may)
    const embeddingCapable = provider === 'openai' || provider === 'openrouter' || provider === 'custom';
    // Anthropic has no embedding API
    const embeddingAvailable = provider !== 'anthropic' && embeddingCapable;

    try {
      await db.$client.query(
        `INSERT INTO llm_config (team_id, provider, api_key_hash, embedding_available)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id) DO UPDATE
         SET provider = EXCLUDED.provider,
             api_key_hash = EXCLUDED.api_key_hash,
             embedding_available = EXCLUDED.embedding_available,
             updated_at = NOW()`,
        [teamId, provider, `hash:${apiKey}`, embeddingAvailable],
      );

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
      throw new InternalError('Failed to update LLM configuration', { cause: err });
    }
  });

  return routes;
}
