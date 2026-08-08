/**
 * Claude (Anthropic Messages API) structured tool-use adapter (AGPL-3.0-only, M0-F1-04).
 *
 * This adapter implements the provider-native structured-output mechanism for
 * Claude: forced single-tool use via the Anthropic Messages API.
 *
 * The adapter builds the request and parses the response; it does NOT handle
 * timeout/abort orchestration, Zod re-validation, or error redaction — those
 * are the shared responsibility of the factory (factory.ts). The adapter's
 * single job is Claude ↔ JSON Schema conversion at the wire level:
 *
 *   1. Build an Anthropic Messages request with `tool_choice: { type: "tool" }`
 *      and `input_schema` derived from the caller's Zod schema (§5.2: provider-
 *      native structured output via forced tool use).
 *   2. Parse the Anthropic response envelope and extract the `tool_use` block
 *      named `record_structured_output`.
 *
 * The adapter never falls back to text parsing: a 2xx response without a
 * `tool_use` block is an explicit `provider_error` (§5.2: no free-text or
 * regex-based extraction). The factory's Zod re-validation is the final
 * authority on correctness.
 */
import type { ResolvedLlmConfig } from '../config/llm.js';
import { LlmError, MAX_OUTPUT_TOKENS, type LlmUsage } from './types.js';

/** Anthropic API host. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Default model for Claude.
 *
 * Anthropic retires dated model ids, and a retired id fails the whole call
 * with a 404 `not_found_error` — a default that silently rots is a default
 * that makes the provider unusable. Keep this pinned to a dated id that is
 * currently listed by `GET /v1/models` for a normal API account.
 */
export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/** The tool name used in the forced-tool-use request and response parsing. */
export const CLAUDE_TOOL_NAME = 'record_structured_output';

/**
 * Build an Anthropic Messages API request with forced single-tool use.
 *
 * The request forces the model to call {@link CLAUDE_TOOL_NAME} with the
 * provided JSON Schema as the tool's `input_schema`. The model cannot respond
 * with free text — if it does, the response parser rejects it.
 *
 * `jsonSchema` must already be root-object shaped. Anthropic validates
 * `input_schema` before it looks at anything else and rejects both a missing
 * root `type` (`input_schema.type: Field required`) and a root combinator
 * (`input_schema does not support oneOf, allOf, or anyOf at the top level`).
 * The factory owns that normalization (`toProviderSchema`) because the OpenAI
 * family enforces the same root-object rule.
 */
export function buildClaudeRequest(
  config: ResolvedLlmConfig & { kind: 'claude' },
  model: string,
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: unknown,
  signal: AbortSignal,
): { url: string; init: RequestInit } {
  return {
    url: `${ANTHROPIC_BASE_URL}/messages`,
    init: {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_API_VERSION,
        'x-api-key': config.apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools: [
          {
            name: CLAUDE_TOOL_NAME,
            description:
              'Record the structured output requested by the caller. ' +
              'Always call this tool; do not respond with free text.',
            input_schema: jsonSchema,
          },
        ],
        tool_choice: { type: 'tool', name: CLAUDE_TOOL_NAME },
      }),
    },
  };
}

/**
 * Parsed result from a Claude Messages API response.
 */
export interface ClaudeExtracted {
  /** The raw value extracted from the tool_use block's `input` field. */
  value: unknown;
  /** The provider-reported model identifier, or a fallback. */
  providerModel: string;
  /** Token counts from `usage`, when the envelope carried them. */
  usage?: LlmUsage;
  /**
   * True when Anthropic's own `stop_reason: "max_tokens"` says generation
   * was cut off by {@link MAX_OUTPUT_TOKENS} — the adapter still returns
   * whatever `tool_use.input` is present (its job is extraction, not
   * validation; see the class doc), but the factory's Zod re-validation
   * uses this flag to tell a truncation failure apart from a genuine model
   * mistake (`output_truncated` vs `schema_validation_failed`).
   */
  truncated: boolean;
}

/**
 * Parse a Claude Messages API response body and extract the structured output.
 *
 * Only looks for a `tool_use` content block named {@link CLAUDE_TOOL_NAME}.
 * A 2xx response without such a block means the model did not honor the forced
 * tool-use instruction — treated as an explicit {@link LlmError} with kind
 * `provider_error` (§5.2: no text-parsing fallback).
 *
 * Error responses (non-2xx) must be caught by the caller before this function
 * is invoked; they are not expected to reach here.
 */
export function parseClaudeResponse(
  raw: string,
  requestId: string,
  fallbackModel: string,
): ClaudeExtracted {
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
  const usage = parseClaudeUsage(envelope.usage);
  const truncated = envelope.stop_reason === 'max_tokens';

  const content = envelope.content;
  if (!Array.isArray(content)) {
    throw new LlmError('empty_output', 'claude', requestId);
  }

  for (const block of content) {
    if (
      isObject(block) &&
      block.type === 'tool_use' &&
      block.name === CLAUDE_TOOL_NAME
    ) {
      return usage
        ? { value: block.input, providerModel, usage, truncated }
        : { value: block.input, providerModel, truncated };
    }
  }

  // A 2xx with no tool_use block means the model did not honor forced tool use.
  // This is the key "no text-parsing fallback" enforcement: prose responses are
  // rejected, not parsed.
  throw new LlmError('provider_error', 'claude', requestId);
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * Normalize Anthropic's `usage` envelope into {@link LlmUsage}.
 *
 * Anthropic reports `input_tokens`/`output_tokens` and no total, so the total
 * is derived. Cache-tier counters (`cache_creation_input_tokens` and friends)
 * are deliberately ignored: they are billing detail, not the prompt/completion
 * split the quality report needs. Anything unparseable yields `undefined` —
 * "not reported" must not be recorded as zero.
 */
function parseClaudeUsage(raw: unknown): LlmUsage | undefined {
  if (!isObject(raw)) return undefined;
  const promptTokens = raw['input_tokens'];
  const completionTokens = raw['output_tokens'];
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') {
    return undefined;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
