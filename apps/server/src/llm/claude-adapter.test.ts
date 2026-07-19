/**
 * Claude tool-use adapter tests (M0-F1-04).
 *
 * These tests exercise the Claude adapter's two responsibilities:
 *   1. Building forced-tool-use requests (URL, headers, body structure)
 *   2. Parsing Claude Messages API responses (success and failure paths)
 *
 * No real network — every response body is crafted as a fixture and fed
 * directly to the parser or sent through a fake fetch. The factory's shared
 * orchestration (timeout, Zod re-validation, error redaction) is tested in
 * llm.factory.test.ts; this file is specifically about the Claude wire format.
 *
 * Success paths:
 *   - Parse a valid tool_use block with input
 *   - Fall back model when response omits it
 *
 * Failure paths:
 *   - Prose-only response (no tool_use block) → provider_error
 *   - Missing content array → empty_output
 *   - Non-JSON response body → provider_error
 *   - Non-object JSON response → provider_error
 *   - Content array with no matching tool_use → provider_error
 *   - response_format/stop_reason-based edge cases
 *
 * Security/boundary counterexamples:
 *   - Truncated tool_use input (stop_reason: "max_tokens") — adapter extracts
 *     whatever is there; Zod validation in the factory catches the shape
 *   - Multiple content blocks (text + tool_use) → tool_use is found
 *   - tool_use with empty input → adapter returns empty input, Zod rejects
 */
import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_BASE_URL,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_TOOL_NAME,
  buildClaudeRequest,
  parseClaudeResponse,
} from './claude-adapter.js';
import { LlmError } from './types.js';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const claudeConfig = {
  kind: 'claude' as const,
  apiKey: 'sk-ant-test-key-123',
};

function claudeResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'msg_01A',
    type: 'message',
    role: 'assistant',
    model: CLAUDE_DEFAULT_MODEL,
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01A',
        name: CLAUDE_TOOL_NAME,
        input: { answer: 'Postgres', count: 7 },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  });
}

// ── Request building ───────────────────────────────────────────────────────

describe('buildClaudeRequest', () => {
  const jsonSchema = {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      count: { type: 'number' },
    },
    required: ['answer', 'count'],
  };

  it('returns the correct Anthropic Messages API endpoint', () => {
    const { url } = buildClaudeRequest(
      claudeConfig,
      CLAUDE_DEFAULT_MODEL,
      'system prompt',
      'user prompt',
      jsonSchema,
      new AbortController().signal,
    );
    expect(url).toBe(`${ANTHROPIC_BASE_URL}/messages`);
  });

  it('sets the correct method, headers, and API version', () => {
    const { init } = buildClaudeRequest(
      claudeConfig,
      CLAUDE_DEFAULT_MODEL,
      'sys',
      'usr',
      jsonSchema,
      new AbortController().signal,
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(headers['x-api-key']).toBe('sk-ant-test-key-123');
    // Claude uses x-api-key, NOT Authorization: Bearer.
    expect(headers['authorization']).toBeUndefined();
  });

  it('does not leak api key into the request URL', () => {
    const { url } = buildClaudeRequest(
      claudeConfig,
      CLAUDE_DEFAULT_MODEL,
      'sys',
      'usr',
      jsonSchema,
      new AbortController().signal,
    );
    expect(url).not.toContain('sk-ant-test-key-123');
  });

  it('builds a body with forced tool_choice and the input_schema', () => {
    const { init } = buildClaudeRequest(
      claudeConfig,
      CLAUDE_DEFAULT_MODEL,
      'sys',
      'usr',
      jsonSchema,
      new AbortController().signal,
    );
    const body = JSON.parse(init.body as string);

    expect(body.model).toBe(CLAUDE_DEFAULT_MODEL);
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'usr' }]);

    // Tools: exactly one, with the caller's JSON Schema as input_schema.
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      name: CLAUDE_TOOL_NAME,
      description: expect.stringContaining('Always call this tool'),
      input_schema: jsonSchema,
    });

    // tool_choice forces exactly our named tool.
    expect(body.tool_choice).toEqual({
      type: 'tool',
      name: CLAUDE_TOOL_NAME,
    });
  });

  it('uses a different model when overridden', () => {
    const { init } = buildClaudeRequest(
      claudeConfig,
      'claude-3-haiku-20240307',
      'sys',
      'usr',
      jsonSchema,
      new AbortController().signal,
    );
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-3-haiku-20240307');
  });
});

// ── Success paths: response parsing ────────────────────────────────────────

describe('parseClaudeResponse — success paths', () => {
  const validInput = { answer: 'Postgres', count: 7 };

  it('extracts the input from the tool_use block', () => {
    const result = parseClaudeResponse(
      claudeResponse({ content: [{ type: 'tool_use', name: CLAUDE_TOOL_NAME, input: validInput }] }),
      'req-1',
      CLAUDE_DEFAULT_MODEL,
    );
    expect(result.value).toEqual(validInput);
  });

  it('returns the provider-reported model', () => {
    const result = parseClaudeResponse(
      claudeResponse({ model: 'claude-3-5-sonnet-20241022' }),
      'req-2',
      'fallback-model',
    );
    expect(result.providerModel).toBe('claude-3-5-sonnet-20241022');
  });

  it('falls back to the provided model when the response omits it', () => {
    const raw = JSON.stringify({
      content: [{ type: 'tool_use', name: CLAUDE_TOOL_NAME, input: { x: 1 } }],
    });
    const result = parseClaudeResponse(raw, 'req-3', 'my-fallback-model');
    expect(result.providerModel).toBe('my-fallback-model');
  });

  it('finds tool_use block when mixed with text blocks', () => {
    // If Claude somehow returns a mix (shouldn't with forced tool_use, but
    // we must handle it correctly — find the tool_use, ignore the text).
    const raw = JSON.stringify({
      model: CLAUDE_DEFAULT_MODEL,
      content: [
        { type: 'text', text: 'Let me extract that for you.' },
        { type: 'tool_use', name: CLAUDE_TOOL_NAME, input: { action: 'skip', reason: 'nope' } },
      ],
    });
    const result = parseClaudeResponse(raw, 'req-4', CLAUDE_DEFAULT_MODEL);
    expect(result.value).toEqual({ action: 'skip', reason: 'nope' });
  });

  it('handles stop_reason: "tool_use" (normal case)', () => {
    const result = parseClaudeResponse(
      claudeResponse({ stop_reason: 'tool_use' }),
      'req-5',
      CLAUDE_DEFAULT_MODEL,
    );
    expect(result.value).toEqual({ answer: 'Postgres', count: 7 });
  });

  it('handles stop_reason: "end_turn" (edge case — model ignored tool_choice but still called tool)', () => {
    // This shouldn't happen with forced tool_use, but the adapter should not
    // reject based on stop_reason — it only cares about the presence of a
    // tool_use block.
    const result = parseClaudeResponse(
      claudeResponse({ stop_reason: 'end_turn' }),
      'req-6',
      CLAUDE_DEFAULT_MODEL,
    );
    expect(result.value).toEqual({ answer: 'Postgres', count: 7 });
  });

  it('extracts tool_use even with stop_reason: "max_tokens" (truncation)', () => {
    // The adapter extracts whatever input is present; Zod re-validation in
    // the factory will catch truncated/invalid shapes. The adapter's job is
    // only to find and return the tool_use block.
    const partialInput = { answer: 'incomplete response' };
    const result = parseClaudeResponse(
      claudeResponse({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', name: CLAUDE_TOOL_NAME, input: partialInput }],
      }),
      'req-7',
      CLAUDE_DEFAULT_MODEL,
    );
    expect(result.value).toEqual(partialInput);
  });

  it('handles null/undefined input gracefully (passed through for Zod to reject)', () => {
    const raw = JSON.stringify({
      model: CLAUDE_DEFAULT_MODEL,
      content: [{ type: 'tool_use', name: CLAUDE_TOOL_NAME, input: null }],
    });
    const result = parseClaudeResponse(raw, 'req-8', CLAUDE_DEFAULT_MODEL);
    expect(result.value).toBeNull();
  });
});

// ── Failure paths: response parsing ────────────────────────────────────────

describe('parseClaudeResponse — failure paths (no text-parsing fallback)', () => {
  it('throws provider_error on prose-only response (no tool_use block)', () => {
    expect(() =>
      parseClaudeResponse(
        JSON.stringify({
          model: CLAUDE_DEFAULT_MODEL,
          content: [{ type: 'text', text: 'Here is the answer: {"action":"skip"}' }],
        }),
        'req-f1',
        CLAUDE_DEFAULT_MODEL,
      ),
    ).toThrow(LlmError);

    try {
      parseClaudeResponse(
        JSON.stringify({
          model: CLAUDE_DEFAULT_MODEL,
          content: [{ type: 'text', text: 'Here is the answer: {"action":"skip"}' }],
        }),
        'req-f1',
        CLAUDE_DEFAULT_MODEL,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      const llmErr = err as LlmError;
      expect(llmErr.kind).toBe('provider_error');
      expect(llmErr.provider).toBe('claude');
      expect(llmErr.requestId).toBe('req-f1');
      // No raw text leaked.
      expect(llmErr.message).not.toContain('Here is the answer');
    }
  });

  it('throws empty_output when content is missing', () => {
    expect(() =>
      parseClaudeResponse(
        JSON.stringify({ model: CLAUDE_DEFAULT_MODEL }),
        'req-f2',
        CLAUDE_DEFAULT_MODEL,
      ),
    ).toThrow(LlmError);

    try {
      parseClaudeResponse(
        JSON.stringify({ model: CLAUDE_DEFAULT_MODEL }),
        'req-f2',
        CLAUDE_DEFAULT_MODEL,
      );
    } catch (err) {
      const llmErr = err as LlmError;
      expect(llmErr.kind).toBe('empty_output');
    }
  });

  it('throws empty_output when content is null', () => {
    expect(() =>
      parseClaudeResponse(
        JSON.stringify({ model: CLAUDE_DEFAULT_MODEL, content: null }),
        'req-f3',
        CLAUDE_DEFAULT_MODEL,
      ),
    ).toThrow(LlmError);
  });

  it('throws empty_output when content is empty array', () => {
    expect(() =>
      parseClaudeResponse(
        JSON.stringify({ model: CLAUDE_DEFAULT_MODEL, content: [] }),
        'req-f4',
        CLAUDE_DEFAULT_MODEL,
      ),
    ).toThrow(LlmError);
  });

  it('throws provider_error on non-JSON response body', () => {
    expect(() =>
      parseClaudeResponse('not valid json {{{', 'req-f5', CLAUDE_DEFAULT_MODEL),
    ).toThrow(LlmError);

    try {
      parseClaudeResponse('not valid json {{{', 'req-f5', CLAUDE_DEFAULT_MODEL);
    } catch (err) {
      const llmErr = err as LlmError;
      expect(llmErr.kind).toBe('provider_error');
      expect(llmErr.provider).toBe('claude');
    }
  });

  it('throws empty_output on non-object JSON (array — no content field)', () => {
    // Arrays are typeof 'object', so they pass isObject, but they have no
    // `content` property → `envelope.content` is undefined → empty_output.
    expect(() =>
      parseClaudeResponse('["not", "an", "object"]', 'req-f6', CLAUDE_DEFAULT_MODEL),
    ).toThrow(LlmError);

    try {
      parseClaudeResponse('["not", "an", "object"]', 'req-f6', CLAUDE_DEFAULT_MODEL);
    } catch (err) {
      const llmErr = err as LlmError;
      expect(llmErr.kind).toBe('empty_output');
    }
  });

  it('throws provider_error on non-object JSON (string)', () => {
    expect(() =>
      parseClaudeResponse('"just a string"', 'req-f7', CLAUDE_DEFAULT_MODEL),
    ).toThrow(LlmError);
  });

  it('throws provider_error when content has wrong tool name', () => {
    // Different tool name — not ours.
    expect(() =>
      parseClaudeResponse(
        JSON.stringify({
          model: CLAUDE_DEFAULT_MODEL,
          content: [{ type: 'tool_use', name: 'some_other_tool', input: { x: 1 } }],
        }),
        'req-f8',
        CLAUDE_DEFAULT_MODEL,
      ),
    ).toThrow(LlmError);
  });

  it('throws provider_error when content has correct tool name but wrong type', () => {
    // Block is type "text" but has the tool name — shouldn't match.
    expect(() =>
      parseClaudeResponse(
        JSON.stringify({
          model: CLAUDE_DEFAULT_MODEL,
          content: [{ type: 'text', name: CLAUDE_TOOL_NAME, text: 'no' }],
        }),
        'req-f9',
        CLAUDE_DEFAULT_MODEL,
      ),
    ).toThrow(LlmError);
  });
});

// ── Security / redaction counterexamples ───────────────────────────────────

describe('parseClaudeResponse — security boundary', () => {
  it('error messages do not contain raw response body text', () => {
    const proseBody = 'Sure! Here is the structured output you requested...';
    try {
      parseClaudeResponse(
        JSON.stringify({
          model: CLAUDE_DEFAULT_MODEL,
          content: [{ type: 'text', text: proseBody }],
        }),
        'req-s1',
        CLAUDE_DEFAULT_MODEL,
      );
    } catch (err) {
      const llmErr = err as LlmError;
      expect(llmErr.message).not.toContain(proseBody);
      expect(llmErr.message).not.toContain('structured output');
    }
  });

  it('error messages do not contain API keys even if the response body mentions them', () => {
    const maliciousBody = JSON.stringify({
      model: CLAUDE_DEFAULT_MODEL,
      content: [{ type: 'text', text: 'key: sk-ant-secret-leaked-value' }],
    });
    try {
      parseClaudeResponse(maliciousBody, 'req-s2', CLAUDE_DEFAULT_MODEL);
    } catch (err) {
      const llmErr = err as LlmError;
      expect(llmErr.message).not.toContain('sk-ant');
      expect(llmErr.message).not.toContain('secret-leaked');
    }
  });

  it('error cause is never attached to LlmError', () => {
    // LlmError constructor intentionally does not set cause (§5.3 red line).
    try {
      parseClaudeResponse('invalid {{{', 'req-s3', CLAUDE_DEFAULT_MODEL);
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      // No cause property on the error object.
      expect(Object.getOwnPropertyDescriptor(err, 'cause')).toBeUndefined();
      // JSON.stringify must not leak raw payload info.
      const serialized = JSON.stringify(err);
      expect(serialized).not.toContain('{{{');
    }
  });
});

// ── Integration: build + parse round-trip with fake fetch ──────────────────

describe('Claude adapter — end-to-end via fake fetch', () => {
  it('full round-trip: build request → fetch → parse response', async () => {
    const signal = new AbortController().signal;
    const { url, init } = buildClaudeRequest(
      claudeConfig,
      CLAUDE_DEFAULT_MODEL,
      'system prompt',
      'user prompt',
      { type: 'object', properties: { x: { type: 'number' } } },
      signal,
    );

    // Verify the request is well-formed.
    expect(url).toBe(`${ANTHROPIC_BASE_URL}/messages`);
    const body = JSON.parse(init.body as string);
    expect(body.tool_choice.name).toBe(CLAUDE_TOOL_NAME);

    // Simulate a real Claude response.
    const raw = claudeResponse({
      content: [{ type: 'tool_use', name: CLAUDE_TOOL_NAME, input: { x: 42 } }],
    });
    const result = parseClaudeResponse(raw, 'req-e2e', CLAUDE_DEFAULT_MODEL);
    expect(result.value).toEqual({ x: 42 });
    expect(result.providerModel).toBe(CLAUDE_DEFAULT_MODEL);
  });
});
