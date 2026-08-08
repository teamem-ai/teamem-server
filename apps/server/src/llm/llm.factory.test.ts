/**
 * Factory + port tests (M0-F1-02).
 *
 * These tests exercise the real request construction, abort/timeout wiring,
 * response parsing, Zod re-validation, and redacted error mapping of
 * {@link createLlmClient} by injecting a fake `fetch` at the external boundary
 * — the only place mocks are permitted by the engineering red lines. No real
 * API keys are used and no network is touched; the fake `fetch` still receives
 * the real headers, URL, and JSON body the production client would send, and
 * the fake responses are shaped exactly like the real provider envelopes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { f1Output } from '../compiler/f1/output.js';
import { llmProviderConfig } from '../config/llm.js';
import { createLlmClient, DEFAULT_MODELS, SCHEMA_ENVELOPE_PROPERTY } from './factory.js';
import { LlmError, MAX_OUTPUT_TOKENS, type FetchLike, type LlmProviderKind } from './types.js';

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const API_KEYS: Record<LlmProviderKind, string> = {
  claude: 'sk-ant-secret-claude',
  openai: 'sk-openai-secret',
  openrouter: 'sk-or-secret',
  custom: 'custom-secret',
};

const byoConfigs = [
  { kind: 'claude', apiKey: API_KEYS.claude },
  { kind: 'openai', apiKey: API_KEYS.openai },
  { kind: 'openrouter', apiKey: API_KEYS.openrouter },
  { kind: 'custom', baseUrl: 'https://llm.example.test/v1', apiKey: API_KEYS.custom },
] as const;

const answerSchema = z.strictObject({ answer: z.string(), count: z.number() });

/** A captured request, surfaced to tests via the fake fetch. */
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

function makeRecorder(
  respond: (captured: Captured) => Response,
  calls: Captured[],
): FetchLike {
  return async (input, init) => {
    const headers: Record<string, string> = {};
    const entries = init?.headers;
    if (entries && typeof entries === 'object') {
      for (const [k, v] of Object.entries(entries as Record<string, string>)) {
        headers[k] = v;
      }
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const captured: Captured = {
      url: input,
      method: init?.method ?? 'GET',
      headers,
      body,
      signal: init?.signal ?? undefined,
    };
    calls.push(captured);
    return respond(captured);
  };
}

function okClaude(
  value: unknown,
  model = 'claude-sonnet-4-5-20250929',
  usage?: unknown,
): Response {
  return new Response(
    JSON.stringify({
      model,
      content: [{ type: 'tool_use', name: 'record_structured_output', input: value }],
      ...(usage === undefined ? {} : { usage }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function okOpenAi(value: unknown, model = 'gpt-4o-2024-08-06', usage?: unknown): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content: JSON.stringify(value) } }],
      ...(usage === undefined ? {} : { usage }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const validValue = { answer: 'Postgres', count: 7 };

/* ── CLI acceptance: instantiate all four BYO configs ─────────────────────── */

describe('createLlmClient — instantiates all four BYO configurations', () => {
  it.each(byoConfigs)('builds a client for $kind without throwing', (config) => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => new Response('{}', { status: 200 }), calls);
    const deps = config.kind === 'custom' ? { fetch, defaultModel: 'local-model' } : { fetch };
    expect(() => createLlmClient(config, deps)).not.toThrow();
    // Construction must NOT have issued any request.
    expect(calls).toHaveLength(0);
  });

  it('uses DEFAULT_MODELS for the three first-party providers', () => {
    expect(DEFAULT_MODELS.claude).toBe('claude-sonnet-4-5-20250929');
    expect(DEFAULT_MODELS.openai).toBe('gpt-4o-2024-08-06');
    expect(DEFAULT_MODELS.openrouter).toBe('openai/gpt-4o-2024-08-06');
    expect(DEFAULT_MODELS.custom).toBe('');
  });
});

/* ── CLI acceptance: platform-managed fails before any network request ────── */

describe('createLlmClient — rejects platform-managed before network I/O', () => {
  it('throws an LlmError(config_rejected) synchronously and never calls fetch', () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => new Response('{}', { status: 200 }), calls);
    const config = llmProviderConfig.parse({ kind: 'platform-managed' });
    expect(() => createLlmClient(config, { fetch })).toThrow(LlmError);
    // The rejection provably precedes any network call.
    expect(calls).toHaveLength(0);
  });

  it('re-rejects platform-managed even though resolveLlmConfig already would', () => {
    // The factory is the boundary guard, independent of the config resolver.
    let caught: LlmError | undefined;
    try {
      createLlmClient(llmProviderConfig.parse({ kind: 'platform-managed' }), {
        fetch: makeRecorder(() => new Response('{}', { status: 200 }), []),
      });
    } catch (err) {
      caught = err instanceof LlmError ? err : undefined;
    }
    expect(caught?.kind).toBe('config_rejected');
  });
});

/* ── Success paths ────────────────────────────────────────────────────────── */

describe('structured — success path for each BYO provider', () => {
  it('claude: sends forced-tool request, parses tool_use input, Zod-validates', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okClaude(validValue), calls);
    const client = createLlmClient(byoConfigs[0], { fetch });

    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-1',
    });

    expect(res.output).toEqual(validValue);
    expect(res.model).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      requestId: 'req-1',
    });

    const req = calls[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.method).toBe('POST');
    expect(req.headers['x-api-key']).toBe(API_KEYS.claude);
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['authorization']).toBeUndefined();
    // Forced single-tool use, provider-native structured output.
    expect(req.body).toMatchObject({
      // A cap that's too tight doesn't error — the provider silently
      // truncates and returns 200, so the JSON comes back unterminated and
      // fails schema validation with no hint it was ever a length problem.
      // Pins down a real production failure (F2's mergedBody can run to
      // 50,000 chars, far past the 1,024-token cap this used to send).
      max_tokens: MAX_OUTPUT_TOKENS,
      tool_choice: { type: 'tool', name: 'record_structured_output' },
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: 'record_structured_output', input_schema: expect.any(Object) }),
      ]),
    });
    // The input_schema is derived from the caller's Zod schema.
    const inputSchema = (req.body as { tools: [{ input_schema: { type: string; properties: Record<string, unknown> } }] }).tools[0].input_schema;
    expect(inputSchema.type).toBe('object');
    expect(inputSchema.properties.answer).toEqual({ type: 'string' });
    expect(inputSchema.properties.count).toEqual({ type: 'number' });
    // No $schema anchor leaked into the provider schema.
    expect((inputSchema as Record<string, unknown>).$schema).toBeUndefined();
    // Caller never sees the model-invented server-owned fields — Zod validated.
    void req.signal;
  });

  it('openai: sends response_format json_schema and parses message.content', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okOpenAi(validValue), calls);
    const client = createLlmClient(byoConfigs[1], { fetch });

    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-2',
    });

    expect(res.output).toEqual(validValue);
    expect(res.model.provider).toBe('openai');
    expect(res.model.requestId).toBe('req-2');

    const req = calls[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers['authorization']).toBe(`Bearer ${API_KEYS.openai}`);
    expect(req.headers['x-api-key']).toBeUndefined();
    expect(req.body).toMatchObject({
      // Same length-truncation concern as the Claude path above — the
      // OpenAI-compatible request previously sent no max_tokens at all,
      // leaving truncation entirely up to whatever default the routed
      // backend happened to apply.
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'teamem_structured_output',
          schema: expect.objectContaining({ type: 'object' }),
          strict: true,
        },
      },
    });
    expect(
      (req.body as { response_format: { json_schema: { schema: Record<string, unknown> } } })
        .response_format.json_schema.schema.$schema,
    ).toBeUndefined();
  });

  it('openrouter: targets the OpenRouter endpoint and adds X-Title', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okOpenAi(validValue, 'openai/gpt-4o-2024-08-06'), calls);
    const client = createLlmClient(byoConfigs[2], { fetch });

    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-3',
    });

    expect(res.output).toEqual(validValue);
    expect(res.model.model).toBe('openai/gpt-4o-2024-08-06');
    expect(res.model.provider).toBe('openrouter');

    const req = calls[0]!;
    expect(req.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req.headers['X-Title']).toBe('teamem');
    expect(req.headers['authorization']).toBe(`Bearer ${API_KEYS.openrouter}`);
  });

  it('custom: targets the configured baseUrl (trailing slash trimmed) and defaultModel is required', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(
      () => okOpenAi(validValue, 'local-model'),
      calls,
    );
    const client = createLlmClient(byoConfigs[3], {
      fetch,
      defaultModel: 'local-model',
    });

    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-4',
    });

    expect(res.output).toEqual(validValue);
    expect(res.model.model).toBe('local-model');
    expect(calls[0]!.url).toBe('https://llm.example.test/v1/chat/completions');
  });

  it('honours a per-request timeoutMs override and does not abort a fast response', async () => {
    const fetch = makeRecorder(() => okOpenAi(validValue), []);
    const client = createLlmClient(byoConfigs[1], { fetch });
    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      timeoutMs: 5_000,
      requestId: 'req-5',
    });
    expect(res.output).toEqual(validValue);
  });
});

/* ── Failure paths ────────────────────────────────────────────────────────── */

describe('structured — failure paths', () => {
  it('http_error on non-2xx, with status but no body content leak', async () => {
    const fetch = makeRecorder(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
        }),
      [],
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-x',
      }),
    ).rejects.toMatchObject({ kind: 'http_error', httpStatus: 429 });
  });

  it('schema_validation_failed when provider JSON does not match the Zod schema', async () => {
    // wrong shape: count is missing, answer is a number.
    const fetch = makeRecorder(
      () => okOpenAi({ answer: 42 }),
      [],
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-v',
      }),
    ).rejects.toMatchObject({ kind: 'schema_validation_failed', requestId: 'req-v' });
  });

  it('output_truncated (not schema_validation_failed) when OpenAI-family content is cut off mid-JSON and finish_reason is "length"', async () => {
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({
            model: 'gpt-4o-2024-08-06',
            choices: [
              {
                finish_reason: 'length',
                // Truncated mid-word — exactly what a max_tokens cutoff produces.
                message: { content: '{"answer": "Post' },
              },
            ],
          }),
          { status: 200 },
        ),
      [],
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-trunc-1',
      }),
    ).rejects.toMatchObject({ kind: 'output_truncated', requestId: 'req-trunc-1' });
  });

  it('output_truncated when OpenAI-family content parses as JSON but is missing a field because finish_reason is "length"', async () => {
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({
            model: 'gpt-4o-2024-08-06',
            choices: [
              {
                finish_reason: 'length',
                message: { content: JSON.stringify({ answer: 'Postgres' }) }, // missing `count`
              },
            ],
          }),
          { status: 200 },
        ),
      [],
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-trunc-2',
      }),
    ).rejects.toMatchObject({ kind: 'output_truncated' });
  });

  it('does not report output_truncated when finish_reason is absent and the schema simply does not match', async () => {
    // Regression guard: a genuine model mistake (no truncation involved)
    // must still surface as schema_validation_failed, not output_truncated.
    const fetch = makeRecorder(() => okOpenAi({ answer: 42 }), []);
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-notrunc',
      }),
    ).rejects.toMatchObject({ kind: 'schema_validation_failed' });
  });

  it('output_truncated when Claude stop_reason is "max_tokens" and the partial tool_use input fails the schema', async () => {
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            stop_reason: 'max_tokens',
            content: [
              {
                type: 'tool_use',
                name: 'record_structured_output',
                input: { answer: 'incomplete' }, // missing `count`
              },
            ],
          }),
          { status: 200 },
        ),
      [],
    );
    const client = createLlmClient(byoConfigs[0], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-trunc-claude',
      }),
    ).rejects.toMatchObject({ kind: 'output_truncated', provider: 'claude' });
  });

  it('a Claude stop_reason of "max_tokens" does not fail the call when the tool_use input still validates', async () => {
    // Edge case: generation was cut off, but the forced tool call itself had
    // already completed validly before the cutoff — must not be misreported
    // as a truncation failure.
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            stop_reason: 'max_tokens',
            content: [
              { type: 'tool_use', name: 'record_structured_output', input: validValue },
            ],
          }),
          { status: 200 },
        ),
      [],
    );
    const client = createLlmClient(byoConfigs[0], { fetch });

    const result = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-trunc-ok',
    });

    expect(result.output).toEqual(validValue);
  });

  it('empty_output when chat completion has no choices', async () => {
    const fetch = makeRecorder(
      () => new Response(JSON.stringify({ model: 'gpt-4o', choices: [] }), { status: 200 }),
      [],
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-e',
      }),
    ).rejects.toMatchObject({ kind: 'empty_output' });
  });

  it('provider_error when Claude returns 2xx with no tool_use block', async () => {
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({ model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'no' }] }),
          { status: 200 },
        ),
      [],
    );
    const client = createLlmClient(byoConfigs[0], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-p',
      }),
    ).rejects.toMatchObject({ kind: 'provider_error', provider: 'claude' });
  });

  it('provider_error when the provider returns non-JSON on a 2xx', async () => {
    const fetch = makeRecorder(() => new Response('not json', { status: 200 }), []);
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-b',
      }),
    ).rejects.toMatchObject({ kind: 'provider_error' });
  });
});

/* ── Timeout / abort boundary ─────────────────────────────────────────────── */

describe('structured — timeout and abort', () => {
  it('timeout when the response exceeds timeoutMs (own abort)', async () => {
    const fetch: FetchLike = async (_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    };
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        timeoutMs: 10,
        requestId: 'req-t',
      }),
    ).rejects.toMatchObject({ kind: 'timeout', requestId: 'req-t' });
  });

  it('aborted when fetch rejects with AbortError but the signal was not our timeout', async () => {
    // The fake fetch rejects with an AbortError immediately, without aborting
    // the signal — simulating an external abort (e.g. process shutdown).
    const fetch: FetchLike = async () => {
      const err = new Error('aborted externally');
      err.name = 'AbortError';
      throw err;
    };
    const client = createLlmClient(byoConfigs[1], { fetch, defaultTimeoutMs: 60_000 });

    await expect(
      client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-a',
      }),
    ).rejects.toMatchObject({ kind: 'aborted', requestId: 'req-a' });
  });
});

/* ── Redaction counterexample: no secrets or bodies escape via errors ─────── */

describe('structured — error redaction (§5.3)', () => {
  it('an http_error never contains the api key, request body, or provider error text', async () => {
    const secretBody = `{"error":"boom","key":"${API_KEYS.openai}","leaked":"<private>sensitive</private>"}`;
    const fetch = makeRecorder(
      () => new Response(secretBody, { status: 500 }),
      [],
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    let caught: LlmError | undefined;
    try {
      await client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr-private-payload',
        requestId: 'req-r',
      });
    } catch (err) {
      caught = err instanceof LlmError ? err : undefined;
    }
    expect(caught?.kind).toBe('http_error');
    expect(caught?.cause).toBeUndefined();
    const serialized = JSON.stringify(caught ?? {});
    expect(serialized).not.toContain(API_KEYS.openai);
    expect(serialized).not.toContain('<private>');
    expect(serialized).not.toContain('usr-private-payload');
    expect(serialized).not.toContain('boom');
    expect(caught?.httpStatus).toBe(500);
    // JSON.stringify omits non-enumerable Error.cause; assert against Node's
    // own accessor too, which is what logs/inspect actually surface.
    expect(Object.getOwnPropertyDescriptor(caught, 'cause')).toBeUndefined();
  });

  it('a schema_validation_failed error never carries the raw provider payload or zod error text', async () => {
    const fetch = makeRecorder(() => okOpenAi({ answer: 'unvalidated', secret: API_KEYS.openai }), []);
    const client = createLlmClient(byoConfigs[1], { fetch });

    let caught: LlmError | undefined;
    try {
      await client.structured({
        schema: answerSchema,
        systemPrompt: 'sys',
        userPrompt: 'usr-private',
        requestId: 'req-s',
      });
    } catch (err) {
      caught = err instanceof LlmError ? err : undefined;
    }
    expect(caught?.kind).toBe('schema_validation_failed');
    expect(caught?.cause).toBeUndefined();
    const serialized = JSON.stringify(caught ?? {});
    expect(serialized).not.toContain(API_KEYS.openai);
    expect(serialized).not.toContain('usr-private');
    expect(serialized).not.toContain('secret');
    // The ZodError (which details the raw payload) must not leak via cause.
    expect(Object.getOwnPropertyDescriptor(caught, 'cause')).toBeUndefined();
  });
});

/* ── Real F1 schema: the root of a provider schema must be a plain object ─── */

/**
 * Regression tests for the root-union defect.
 *
 * `f1Output` (and `f2Decision`) are `z.discriminatedUnion`s, which
 * `z.toJSONSchema` renders as a bare root `oneOf` with no `type`. Sending that
 * shape made every real F1/F2 call fail on every provider:
 *
 *   - Anthropic → 400 `tools.0.custom.input_schema.type: Field required`
 *   - Anthropic with `type` added next to the `oneOf` → 400 `input_schema does
 *     not support oneOf, allOf, or anyOf at the top level`
 *   - OpenAI    → 400 `Invalid schema for response_format ...: schema must be a
 *     JSON Schema of 'type: "object"', got 'type: "None"'`
 *
 * The OpenAI rejection above was produced with `strict` absent, so these tests
 * also pin down that omitting `strict` does not make a root union acceptable.
 */
describe('structured — normalizes a root union into a provider-legal object', () => {
  /** The single rule both provider families enforce at the schema root. */
  function expectRootObjectShape(schema: Record<string, unknown>): void {
    expect(schema['type']).toBe('object');
    expect(schema['oneOf']).toBeUndefined();
    expect(schema['anyOf']).toBeUndefined();
    expect(schema['allOf']).toBeUndefined();
    expect(schema['$schema']).toBeUndefined();
  }

  /**
   * Recursively asserts no `oneOf`/`anyOf`/`allOf` survives anywhere in the
   * schema — not just at the root. Pins down the real production failure:
   * OpenRouter routing an OpenAI-shaped `response_format` to an Anthropic-
   * family backend (Bedrock/Azure/Anthropic all observed) rejects `oneOf`
   * anywhere, not only at the root, contradicting the "nested combinators
   * are fine everywhere" assumption a previous revision of this file relied
   * on (see the {@link flattenOneOfBranches} doc in factory.ts).
   */
  function expectNoCombinatorAnywhere(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) expectNoCombinatorAnywhere(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    expect(obj['oneOf']).toBeUndefined();
    expect(obj['anyOf']).toBeUndefined();
    expect(obj['allOf']).toBeUndefined();
    for (const value of Object.values(obj)) expectNoCombinatorAnywhere(value);
  }

  it('claude: flattens the F1 union into a bare object schema — no envelope needed', async () => {
    const calls: Captured[] = [];
    // A bare (unwrapped) payload — flattening means the provider is asked
    // for the branches' properties directly at the root, not inside a
    // "result" envelope.
    const fetch = makeRecorder(
      () => okClaude({ action: 'skip', reason: 'no knowledge' }),
      calls,
    );
    const client = createLlmClient(byoConfigs[0], { fetch });

    const res = await client.structured({
      schema: f1Output,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-f1',
    });

    expect(res.output).toEqual({ action: 'skip', reason: 'no knowledge' });

    const inputSchema = (
      calls[0]!.body as { tools: [{ input_schema: Record<string, unknown> }] }
    ).tools[0].input_schema;
    expectRootObjectShape(inputSchema);
    expectNoCombinatorAnywhere(inputSchema);
    // Only the discriminant is common to every branch — everything else
    // (title/body/path/tags/confidence from `extract`, `reason` from `skip`)
    // stays optional in the merged schema; real enforcement is still the
    // Zod re-validation below, not this hint to the model.
    expect(inputSchema['required']).toEqual(['action']);
    const properties = inputSchema['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['action', 'title', 'body', 'reason']),
    );
    // The discriminant's two literal values merge into one enum rather than
    // one branch silently overwriting the other's `const`.
    expect(properties['action']).toEqual({ type: 'string', enum: ['extract', 'skip'] });
  });

  it('openai: flattens the F1 union and omits strict (properties stay partially optional)', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okOpenAi({ action: 'skip', reason: 'nope' }), calls);
    const client = createLlmClient(byoConfigs[1], { fetch });

    const res = await client.structured({
      schema: f1Output,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-f1b',
    });
    expect(res.output).toEqual({ action: 'skip', reason: 'nope' });

    const envelope = (
      calls[0]!.body as {
        response_format: {
          json_schema: { schema: Record<string, unknown>; strict?: boolean };
        };
      }
    ).response_format.json_schema;
    expectRootObjectShape(envelope.schema);
    expectNoCombinatorAnywhere(envelope.schema);
    expect(envelope.schema['required']).toEqual(['action']);
    // No oneOf survives, but OpenAI strict mode also requires every property
    // to be in `required` — most F1 properties stay optional post-merge, so
    // strict must stay absent even though the combinator rule is satisfied.
    expect(envelope.strict).toBeUndefined();
  });

  it('rejects a bare payload that violates the union even though the provider-side schema is now more permissive', async () => {
    // The flattened schema only requires `action` — `reason` is optional at
    // the JSON-Schema level once merged with `extract`'s branch. Zod remains
    // the authority regardless (§5.2): a `skip` payload missing `reason`
    // must still fail.
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okClaude({ action: 'skip' }), calls); // `reason` missing
    const client = createLlmClient(byoConfigs[0], { fetch });

    await expect(
      client.structured({
        schema: f1Output,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-f1-bad',
      }),
    ).rejects.toMatchObject({ kind: 'schema_validation_failed' });
  });

  it('parses an envelope Anthropic filled with a serialized JSON string (non-flattenable union)', async () => {
    // Observed against the live API: the model may put the serialized object
    // in the envelope property instead of the object itself. Uses a union
    // that flattenOneOfBranches deliberately leaves alone (a primitive
    // branch, not all-object) so this still exercises the envelope-wrap +
    // unwrap path that flattening bypasses for F1/F2.
    const stringOrObject = z.union([z.string(), answerSchema]);
    const calls: Captured[] = [];
    const fetch = makeRecorder(
      () => okClaude({ result: JSON.stringify(validValue) }),
      calls,
    );
    const client = createLlmClient(byoConfigs[0], { fetch });

    const res = await client.structured({
      schema: stringOrObject,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-str-union',
    });
    // unwrapEnvelope JSON.parses the envelope's string value before Zod
    // validation, so this matches the object branch of the union, not the
    // string branch — proving the parse-then-validate path, not just that a
    // string trivially satisfies `z.string()`.
    expect(res.output).toEqual(validValue);

    const inputSchema = (
      calls[0]!.body as { tools: [{ input_schema: Record<string, unknown> }] }
    ).tools[0].input_schema;
    expect(inputSchema['required']).toEqual([SCHEMA_ENVELOPE_PROPERTY]);
  });

  it('leaves an object-root schema unwrapped and sends it with strict:true', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okOpenAi(validValue), calls);
    const client = createLlmClient(byoConfigs[1], { fetch });
    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-strict',
    });
    expect(res.output).toEqual(validValue);

    const envelope = (
      calls[0]!.body as {
        response_format: {
          json_schema: { schema: Record<string, unknown>; strict?: boolean };
        };
      }
    ).response_format.json_schema;
    expect(envelope.strict).toBe(true);
    // No envelope: the caller's own properties are at the root.
    expect(Object.keys(envelope.schema['properties'] as object)).toEqual(['answer', 'count']);
  });

  it('claude: an object-root schema is sent unwrapped too', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okClaude(validValue), calls);
    const client = createLlmClient(byoConfigs[0], { fetch });
    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-plain-claude',
    });
    expect(res.output).toEqual(validValue);

    const inputSchema = (
      calls[0]!.body as { tools: [{ input_schema: Record<string, unknown> }] }
    ).tools[0].input_schema;
    expect(Object.keys(inputSchema['properties'] as object)).toEqual(['answer', 'count']);
  });
});

/* ── Token usage is captured from both provider envelopes ─────────────────── */

describe('structured — reports provider token usage', () => {
  it('normalizes the Anthropic usage envelope', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(
      () =>
        okClaude(validValue, 'claude-sonnet-4-5-20250929', {
          input_tokens: 1020,
          output_tokens: 174,
          cache_read_input_tokens: 0,
        }),
      calls,
    );
    const client = createLlmClient(byoConfigs[0], { fetch });
    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-usage-claude',
    });
    // Anthropic reports no total; it is derived.
    expect(res.usage).toEqual({
      promptTokens: 1020,
      completionTokens: 174,
      totalTokens: 1194,
    });
  });

  it('normalizes the OpenAI-family usage envelope and honors total_tokens', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(
      () =>
        okOpenAi(validValue, 'gpt-4o-2024-08-06', {
          prompt_tokens: 229,
          completion_tokens: 128,
          total_tokens: 357,
        }),
      calls,
    );
    const client = createLlmClient(byoConfigs[1], { fetch });
    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-usage-openai',
    });
    expect(res.usage).toEqual({
      promptTokens: 229,
      completionTokens: 128,
      totalTokens: 357,
    });
  });

  it('leaves usage undefined when the provider does not report it', async () => {
    // "Not reported" must never be recorded as zero cost.
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okOpenAi(validValue), calls);
    const client = createLlmClient(byoConfigs[1], { fetch });
    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-usage-absent',
    });
    expect(res.usage).toBeUndefined();
  });

  it('ignores a malformed usage envelope rather than reporting zeros', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(
      () => okOpenAi(validValue, 'gpt-4o-2024-08-06', { prompt_tokens: 'lots' }),
      calls,
    );
    const client = createLlmClient(byoConfigs[1], { fetch });
    const res = await client.structured({
      schema: answerSchema,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-usage-bad',
    });
    expect(res.usage).toBeUndefined();
  });
});

/* ── Port surface: LlmError shape and redactedMessage ────────────────────── */

describe('LlmError — redacted surface', () => {
  it('stores kind/provider/requestId/httpStatus and a generic, non-leaking message', () => {
    const err = new LlmError('http_error', 'openai', 'req-z', { httpStatus: 503 });
    expect(err.kind).toBe('http_error');
    expect(err.provider).toBe('openai');
    expect(err.requestId).toBe('req-z');
    expect(err.httpStatus).toBe(503);
    expect(err.message).toContain('status 503');
    expect(err.message).toContain('redacted');
  });

  it('non-http kinds omit status and describe the kind generically', () => {
    const err = new LlmError('timeout', 'claude', 'req-y');
    expect(err.httpStatus).toBeUndefined();
    expect(err.message).toContain('timeout');
  });
});
// ── Opt-in diagnostic logging (TEAMEM_LLM_DEBUG) ─────────────────────────────

describe('TEAMEM_LLM_DEBUG diagnostic logging', () => {
  afterEach(() => {
    delete process.env['TEAMEM_LLM_DEBUG'];
    vi.restoreAllMocks();
  });

  it('logs the underlying cause of a provider_error when enabled', async () => {
    process.env['TEAMEM_LLM_DEBUG'] = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 2xx with non-JSON body → extractStructured throws → provider_error.
    const fetch = makeRecorder(() => new Response('not json', { status: 200 }), []);
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({ schema: answerSchema, systemPrompt: 's', userPrompt: 'u', requestId: 'req-dbg' }),
    ).rejects.toMatchObject({ kind: 'provider_error' });

    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('llm_debug'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.kind).toBe('provider_error');
    expect(parsed.requestId).toBe('req-dbg');
    expect(typeof parsed.detail).toBe('string');
    expect(parsed.detail.length).toBeGreaterThan(0);
  });

  it('stays silent when TEAMEM_LLM_DEBUG is not set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = makeRecorder(() => new Response('not json', { status: 200 }), []);
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({ schema: answerSchema, systemPrompt: 's', userPrompt: 'u', requestId: 'req-quiet' }),
    ).rejects.toMatchObject({ kind: 'provider_error' });

    expect(warn.mock.calls.some((c) => String(c[0]).includes('llm_debug'))).toBe(false);
  });

  it('logs kind: output_truncated (not schema_validation_failed) and the raw finish_reason when content is cut off by the token limit', async () => {
    process.env['TEAMEM_LLM_DEBUG'] = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({
            model: 'gpt-4o-2024-08-06',
            choices: [{ finish_reason: 'length', message: { content: '{"answer": "Post' } }],
          }),
          { status: 200 },
        ),
      [],
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({ schema: answerSchema, systemPrompt: 's', userPrompt: 'u', requestId: 'req-dbg-trunc' }),
    ).rejects.toMatchObject({ kind: 'output_truncated' });

    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('llm_debug'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.kind).toBe('output_truncated');
    expect(parsed.detail).toContain('finish_reason: "length"');
  });

  it('logs the actual finish_reason value (not just a boolean) so a non-"length" truncation signal is still visible', async () => {
    process.env['TEAMEM_LLM_DEBUG'] = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({
            model: 'some-model',
            // A backing model proxied through OpenRouter that doesn't
            // normalize to OpenAI's exact "length" vocabulary — the debug
            // log must still surface what it actually said.
            choices: [{ finish_reason: 'max_tokens', message: { content: '{"answer": "Post' } }],
          }),
          { status: 200 },
        ),
      [],
    );
    const client = createLlmClient({ kind: 'openrouter', apiKey: API_KEYS.openrouter }, { fetch });

    await expect(
      client.structured({ schema: answerSchema, systemPrompt: 's', userPrompt: 'u', requestId: 'req-dbg-other' }),
    ).rejects.toMatchObject({ kind: 'schema_validation_failed' });

    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('llm_debug'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.kind).toBe('schema_validation_failed');
    expect(parsed.detail).toContain('finish_reason: "max_tokens"');
  });

  it('scrubs secrets from a logged http_error body', async () => {
    process.env['TEAMEM_LLM_DEBUG'] = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({ error: { message: 'bad key sk-supersecret123456 and tok_abc' } }),
          { status: 401 },
        ),
      [],
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    await expect(
      client.structured({ schema: answerSchema, systemPrompt: 's', userPrompt: 'u', requestId: 'req-http' }),
    ).rejects.toMatchObject({ kind: 'http_error' });

    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('llm_debug'));
    expect(line).toBeDefined();
    expect(line!).not.toContain('sk-supersecret123456');
    expect(line!).toContain('HTTP 401');
  });
});
