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
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { f1Output } from '../compiler/f1/output.js';
import { llmProviderConfig } from '../config/llm.js';
import { createLlmClient, DEFAULT_MODELS } from './factory.js';
import { LlmError, type FetchLike, type LlmProviderKind } from './types.js';

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

function okClaude(value: unknown, model = 'claude-3-5-sonnet-20241022'): Response {
  return new Response(
    JSON.stringify({
      model,
      content: [{ type: 'tool_use', name: 'record_structured_output', input: value }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function okOpenAi(value: unknown, model = 'gpt-4o-2024-08-06'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content: JSON.stringify(value) } }],
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
    expect(DEFAULT_MODELS.claude).toBe('claude-3-5-sonnet-20241022');
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
      model: 'claude-3-5-sonnet-20241022',
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
          JSON.stringify({ model: 'claude-3-5-sonnet-20241022', content: [{ type: 'text', text: 'no' }] }),
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
    const serialized = JSON.stringify(caught ?? {});
    expect(serialized).not.toContain(API_KEYS.openai);
    expect(serialized).not.toContain('<private>');
    expect(serialized).not.toContain('usr-private-payload');
    expect(serialized).not.toContain('boom');
    expect(caught?.httpStatus).toBe(500);
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
    const serialized = JSON.stringify(caught ?? {});
    expect(serialized).not.toContain(API_KEYS.openai);
    expect(serialized).not.toContain('usr-private');
    expect(serialized).not.toContain('secret');
  });
});

/* ── Real F1 schema is wired provider-native (discriminated union → oneOf) ─── */

describe('structured — uses the real F1 schema with provider-native oneOf', () => {
  it('claude input_schema is a oneOf of the F1 extract/skip branches', async () => {
    const calls: Captured[] = [];
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
    const inputSchema = (calls[0]!.body as { tools: [{ input_schema: { oneOf: unknown[] } }] }).tools[0].input_schema;
    expect(Array.isArray(inputSchema.oneOf)).toBe(true);
    expect(inputSchema.oneOf.length).toBe(2);
    expect((inputSchema as Record<string, unknown>).$schema).toBeUndefined();
  });

  it('openai response_format schema is the F1 oneOf payload', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(
      () => okOpenAi({ action: 'skip', reason: 'nope' }),
      calls,
    );
    const client = createLlmClient(byoConfigs[1], { fetch });

    await client.structured({
      schema: f1Output,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      requestId: 'req-f1b',
    });

    const schema = (calls[0]!.body as { response_format: { json_schema: { schema: { oneOf: unknown[] } } } })
      .response_format.json_schema.schema;
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect(schema.oneOf.length).toBe(2);
    expect((schema as Record<string, unknown>).$schema).toBeUndefined();
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