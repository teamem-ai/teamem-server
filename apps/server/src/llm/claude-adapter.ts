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
import { LlmError } from './types.js';

/** Anthropic API host. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Default model for Claude. */
export const CLAUDE_DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';

/** The tool name used in the forced-tool-use request and response parsing. */
export const CLAUDE_TOOL_NAME = 'record_structured_output';

/**
 * Build an Anthropic Messages API request with forced single-tool use.
 *
 * The request forces the model to call {@link CLAUDE_TOOL_NAME} with the
 * provided JSON Schema as the tool's `input_schema`. The model cannot respond
 * with free text — if it does, the response parser rejects it.
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
        max_tokens: 1024,
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
      return { value: block.input, providerModel };
    }
  }

  // A 2xx with no tool_use block means the model did not honor forced tool use.
  // This is the key "no text-parsing fallback" enforcement: prose responses are
  // rejected, not parsed.
  throw new LlmError('provider_error', 'claude', requestId);
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
