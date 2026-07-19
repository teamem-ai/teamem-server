/**
 * LLM client factory (AGPL-3.0-only, M0-F1-02).
 *
 * Turns a {@link ResolvedLlmConfig} into a real provider-hosted {@link LlmClient}.
 * Four BYO shapes are supported — `claude`, `openai`, `openrouter`, and `custom`
 * — each wired to its provider-native structured-output mechanism:
 *
 *   - Claude (Anthropic Messages API) — forced single-tool use; the tool
 *     `input_schema` is the JSON Schema derived from the caller's Zod schema.
 *   - OpenAI / OpenRouter / custom OpenAI-compatible — Chat Completions with
 *     `response_format: { type: 'json_schema', ... }`, again derived from Zod.
 *
 * Every adapter does the same two things around the native mechanism, so the
 * compiler does not branch on provider:
 *   1. Convert the caller's Zod schema to JSON Schema via `z.toJSONSchema` and
 *      send it to the provider (§5.2: provider-native structured output).
 *   2. Re-parse and re-validate the provider's JSON payload with the same
 *      Zod schema before returning it (§5.2: never trust an implicit JSON
 *      string; validation failure is an explicit compile failure).
 *
 * `platform-managed` is rejected synchronously, before any transport is built
 * and before any network request could be issued: managed billing does not
 * exist in the self-hosted build (§7), and silently no-op-ing it would be the
 * kind of looks-configured-but-does-nothing state the project forbids.
 *
 * The transport (`fetch`) and a default model/timeout are injectable, so the
 * factory's real request construction — headers, URL, body, abort/timeout
 * wiring, response parsing, Zod re-validation, and redacted error mapping — is
 * exercised end to end in unit tests with a fake `fetch` at the external
 * boundary (the only place mocks are permitted per the engineering red lines).
 */
import { z } from 'zod';

import type { LlmProviderConfig, ResolvedLlmConfig } from '../config/llm.js';
import {
  LlmError,
  type FetchLike,
  type LlmClient,
  type LlmClientDeps,
  type LlmProviderKind,
} from './types.js';

export { LlmError } from './types.js';
export type {
  FetchLike,
  LlmClient,
  LlmClientDeps,
  LlmProviderKind,
  ModelMetadata,
} from './types.js';

/** Anthropic API host. */
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_API_VERSION = '2023-06-01';

/** OpenAI API host. */
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** OpenRouter API host. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Default per-request timeout; a request may override it via `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Sensible, real default models per BYO provider. These are real, deployed
 * model identifiers that each provider accepts for structured-output calls;
 * the composition root or any caller may override them via {@link
 * LlmClientDeps.defaultModel}. They are not demo or mock values — a real call
 * with a real key reaches the real model.
 *
 * The `custom` entry has no universal default: custom endpoints serve whatever
 * the operator points at. Leaving it blank forces an explicit model to be
 * supplied via {@link LlmClientDeps.defaultModel}; without one, the factory
 * rejects the config synchronously with `config_rejected` rather than guessing.
 */
export const DEFAULT_MODELS: Readonly<Record<LlmProviderKind, string>> = Object.freeze({
  claude: 'claude-3-5-sonnet-20241022',
  openai: 'gpt-4o-2024-08-06',
  openrouter: 'openai/gpt-4o-2024-08-06',
  custom: '',
});

/**
 * Build a provider-neutral {@link LlmClient} for a resolved BYO config.
 *
 * Throws synchronously (an {@link LlmError} with kind `config_rejected`) for:
 *   - `platform-managed` (the caller should already have rejected this via
 *     `resolveLlmConfig`, but the factory re-asserts the red line so it cannot
 *     be bypassed by a future config source); and
 *   - a `custom` provider with no model — there is genuinely nothing to call
 *     without one, and guessing would be a silent fallback the red lines forbid.
 *
 * These failures precede any transport construction and any network I/O.
 *
 * @param config a resolved (BYO) provider config — never `platform-managed`.
 * @param deps   optional transport/model/timeout overrides; tests inject a fake
 *               `fetch` here to exercise the real request/response path without
 *               touching the network or needing real API keys.
 */
export function createLlmClient(
  config: LlmProviderConfig,
  deps: LlmClientDeps = {},
): LlmClient {
  if (config.kind === 'platform-managed') {
    // Re-assert at the boundary: the factory is the last place a managed
    // shape could sneak through. Failing here means no transport, no fetch
    // URL, and no headers are ever constructed with a managed config — the
    // rejection provably precedes any network I/O (covered by tests).
    throw new LlmError('config_rejected', 'custom', '', {
      cause: new Error(
        "'platform-managed' is not available in the self-hosted build; " +
          'configure a BYO key (claude/openai/openrouter/custom)',
      ),
    });
  }

  const resolved: ResolvedLlmConfig = config;
  const provider = resolved.kind;
  const model = deps.defaultModel ?? DEFAULT_MODELS[provider];
  if (!model) {
    throw new LlmError('config_rejected', provider, '', {
      cause: new Error(
        `no model configured for '${provider}'; ` +
          'supply one via LlmClientDeps.defaultModel',
      ),
    });
  }

  const timeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new LlmError('config_rejected', provider, '', {
      cause: new Error('no fetch implementation available'),
    });
  }

  return {
    structured: (request) =>
      runStructured(provider, resolved, model, timeoutMs, fetchFn, request),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Core call path                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

async function runStructured<T>(
  provider: LlmProviderKind,
  config: ResolvedLlmConfig,
  model: string,
  defaultTimeoutMs: number,
  fetchFn: FetchLike,
  request: import('./types.js').LlmRequest<T>,
): Promise<import('./types.js').LlmResponse<T>> {
  const timeout = request.timeoutMs ?? defaultTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const jsonSchema = stripSchemaAnchor(z.toJSONSchema(request.schema));
    const url = endpointFor(config);
    const init = buildRequest(
      config,
      model,
      request.systemPrompt,
      request.userPrompt,
      jsonSchema,
      controller.signal,
    );

    let response: Response;
    try {
      response = await fetchFn(url, init as RequestInit);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlmError('timeout', provider, request.requestId);
      }
      throw new LlmError(abortedKind(err), provider, request.requestId, {
        cause: err,
      });
    }

    if (!response.ok) {
      // Drain the body so the socket is freed, but keep none of it.
      await drain(response);
      throw new LlmError('http_error', provider, request.requestId, {
        httpStatus: response.status,
      });
    }

    const raw = await response.text();
    const extracted = extractStructured(provider, raw, request.requestId, model);

    const validation = request.schema.safeParse(extracted.value);
    if (!validation.success) {
      throw new LlmError('schema_validation_failed', provider, request.requestId, {
        cause: validation.error,
      });
    }

    return {
      output: validation.data,
      model: {
        provider,
        model: extracted.providerModel,
        requestId: request.requestId,
      },
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    // Unexpected failure — wrap as a provider_error, never leaking details.
    throw new LlmError('provider_error', provider, request.requestId, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Request construction                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function endpointFor(config: ResolvedLlmConfig): string {
  switch (config.kind) {
    case 'claude':
      return `${ANTHROPIC_BASE_URL}/messages`;
    case 'openai':
      return `${OPENAI_BASE_URL}/chat/completions`;
    case 'openrouter':
      return `${OPENROUTER_BASE_URL}/chat/completions`;
    case 'custom': {
      const base = config.baseUrl.replace(/\/+$/, '');
      return `${base}/chat/completions`;
    }
    default: {
      // Exhaustiveness check; unreachable because platform-managed is rejected earlier.
      const _exhaustive: never = config;
      return _exhaustive;
    }
  }
}

function buildRequest(
  config: ResolvedLlmConfig,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: unknown,
  signal: AbortSignal,
): RequestInit {
  if (config.kind === 'claude') {
    return {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_API_VERSION,
        'x-api-key': config.apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools: [
          {
            name: 'record_structured_output',
            description:
              'Record the structured output requested by the caller. ' +
              'Always call this tool; do not respond with free text.',
            input_schema: jsonSchema,
          },
        ],
        tool_choice: { type: 'tool', name: 'record_structured_output' },
      }),
    };
  }

  // OpenAI / OpenRouter / custom all speak the Chat Completions API.
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  };
  if (config.kind === 'openrouter') {
    headers['X-Title'] = 'teamem';
  }
  return {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'teamem_structured_output',
          schema: jsonSchema,
          strict: true,
        },
      },
    }),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Response parsing                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

interface Extracted {
  value: unknown;
  providerModel: string;
}

function extractStructured(
  provider: LlmProviderKind,
  raw: string,
  requestId: string,
  fallbackModel: string,
): Extracted {
  if (provider === 'claude') {
    return parseClaude(raw, requestId, fallbackModel);
  }
  return parseOpenAiFamily(provider, raw, requestId, fallbackModel);
}

function parseClaude(raw: string, requestId: string, fallbackModel: string): Extracted {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new LlmError('provider_error', 'claude', requestId);
  }
  if (!isObject(envelope)) {
    throw new LlmError('provider_error', 'claude', requestId);
  }
  const providerModel =
    typeof envelope.model === 'string' ? envelope.model : fallbackModel;
  const content = envelope.content;
  if (!Array.isArray(content)) {
    throw new LlmError('empty_output', 'claude', requestId);
  }
  for (const block of content) {
    if (
      isObject(block) &&
      block.type === 'tool_use' &&
      block.name === 'record_structured_output'
    ) {
      return { value: block.input, providerModel };
    }
  }
  // A 2xx with no tool_use block means the model did not honor forced tool use.
  throw new LlmError('provider_error', 'claude', requestId);
}

function parseOpenAiFamily(
  provider: LlmProviderKind,
  raw: string,
  requestId: string,
  fallbackModel: string,
): Extracted {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new LlmError('provider_error', provider, requestId);
  }
  if (!isObject(envelope)) {
    throw new LlmError('provider_error', provider, requestId);
  }
  const providerModel =
    typeof envelope.model === 'string' ? envelope.model : fallbackModel;
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmError('empty_output', provider, requestId);
  }
  const first = choices[0];
  if (!isObject(first) || !isObject(first.message)) {
    throw new LlmError('empty_output', provider, requestId);
  }
  const content = first.message.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmError('empty_output', provider, requestId);
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new LlmError('schema_validation_failed', provider, requestId);
  }
  return { value, providerModel };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `z.toJSONSchema` emits a `$schema` keyword. Providers reject the response
 * format when unfamiliar keywords are present, so drop it before sending.
 */
function stripSchemaAnchor(schema: unknown): unknown {
  if (isObject(schema) && typeof schema.$schema === 'string') {
    const { $schema: _anchor, ...rest } = schema;
    void _anchor;
    return rest;
  }
  return schema;
}

async function drain(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // Ignore read errors on the discarded error body.
  }
}

function abortedKind(err: unknown): 'aborted' | 'provider_error' {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'aborted';
  }
  return 'provider_error';
}