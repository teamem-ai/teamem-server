/**
 * Embedding port + factory tests (M1-EMB-01).
 *
 * These tests exercise the real request construction, abort/timeout wiring,
 * response parsing, validation, and redacted error mapping of
 * {@link createEmbeddingClient} by injecting a fake `fetch` at the external
 * boundary — the only place mocks are permitted by the engineering red lines.
 * No real API keys are used and no network is touched.
 */
import { describe, expect, it } from 'vitest';

import { llmProviderConfig } from '../../config/llm.js';
import { LlmError, type FetchLike, type LlmProviderKind } from '../types.js';
import { createEmbeddingClient, DEFAULT_EMBEDDING_MODELS, EMBEDDING_DIMENSION } from './factory.js';
import type { EmbeddingClient } from './port.js';

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const API_KEYS: Record<LlmProviderKind, string> = {
  claude: 'sk-ant-secret-claude',
  openai: 'sk-openai-secret',
  openrouter: 'sk-or-secret',
  custom: 'custom-secret',
};

const openaiConfig = { kind: 'openai' as const, apiKey: API_KEYS.openai };
const openrouterConfig = { kind: 'openrouter' as const, apiKey: API_KEYS.openrouter };
const customConfig = {
  kind: 'custom' as const,
  baseUrl: 'https://embeddings.example.test/v1',
  apiKey: API_KEYS.custom,
};
const claudeConfig = { kind: 'claude' as const, apiKey: API_KEYS.claude };

/** A captured request, surfaced to tests via the fake fetch. */
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
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
    const captured: Captured = { url: input, method: init?.method ?? 'GET', headers, body };
    calls.push(captured);
    return respond(captured);
  };
}

/** Generate a valid embedding vector of the expected dimension. */
function fakeVector(dim: number = EMBEDDING_DIMENSION): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(i * 0.1));
}

/** Build a valid OpenAI-compatible embeddings response. */
function okEmbedding(vectors: number[][], model = 'text-embedding-3-small'): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: vectors.map((embedding, index) => ({
        object: 'embedding',
        index,
        embedding,
      })),
      model,
      usage: { prompt_tokens: vectors.length * 4, total_tokens: vectors.length * 4 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/* ── CLI acceptance: OpenAI-capable returns non-null client with correct dims ─ */

describe('createEmbeddingClient — returns client for embedding-capable providers', () => {
  it('openai: returns a non-null client and generates 1536-d vectors for each input', async () => {
    const inputs = ['hello world', 'foo bar'];
    const vectors = inputs.map(() => fakeVector());
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okEmbedding(vectors), calls);

    const client = createEmbeddingClient(openaiConfig, { fetch });
    expect(client).not.toBeNull();

    const result = await (client as EmbeddingClient).generate(inputs);
    expect(result).toHaveLength(inputs.length);
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!).toHaveLength(EMBEDDING_DIMENSION);
      expect(result[i]!).toEqual(vectors[i]!);
    }

    // Verify the request shape.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${API_KEYS.openai}`);
    expect(calls[0]!.body).toMatchObject({
      model: 'text-embedding-3-small',
      input: inputs,
      encoding_format: 'float',
    });
  });

  it('openrouter: targets the OpenRouter embeddings endpoint and adds X-Title', async () => {
    const inputs = ['one'];
    const vectors = [fakeVector()];
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okEmbedding(vectors, 'openai/text-embedding-3-small'), calls);

    const client = createEmbeddingClient(openrouterConfig, { fetch });
    expect(client).not.toBeNull();

    const result = await (client as EmbeddingClient).generate(inputs);
    expect(result).toHaveLength(1);
    expect(result[0]!).toHaveLength(EMBEDDING_DIMENSION);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(calls[0]!.headers['X-Title']).toBe('teamem');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${API_KEYS.openrouter}`);
    expect(calls[0]!.body).toMatchObject({
      model: 'openai/text-embedding-3-small',
    });
  });

  it('custom: targets the configured baseUrl/embeddings with explicit model', async () => {
    const inputs = ['a', 'b', 'c'];
    const vectors = inputs.map(() => fakeVector());
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okEmbedding(vectors, 'local-embed-model'), calls);

    const client = createEmbeddingClient(customConfig, {
      fetch,
      defaultModel: 'local-embed-model',
    });
    expect(client).not.toBeNull();

    const result = await (client as EmbeddingClient).generate(inputs);
    expect(result).toHaveLength(3);
    for (const vec of result) {
      expect(vec).toHaveLength(EMBEDDING_DIMENSION);
    }

    expect(calls).toHaveLength(1);
    // Trailing slash stripped.
    expect(calls[0]!.url).toBe('https://embeddings.example.test/v1/embeddings');
    expect(calls[0]!.body).toMatchObject({ model: 'local-embed-model', input: inputs });
  });

  it('custom with trailing-slashed baseUrl strips them correctly', async () => {
    const config = { kind: 'custom' as const, baseUrl: 'https://example.test/v1///', apiKey: 'k' };
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okEmbedding([fakeVector()]), calls);

    const client = createEmbeddingClient(config, { fetch, defaultModel: 'm' });
    await (client as EmbeddingClient).generate(['x']);
    expect(calls[0]!.url).toBe('https://example.test/v1/embeddings');
  });
});

/* ── CLI acceptance: Claude returns null (fallback signal, not error) ────── */

describe('createEmbeddingClient — returns null for non-embedding providers', () => {
  it('claude: returns null without throwing — not an error, a fallback signal', () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => new Response('{}', { status: 200 }), calls);

    let client: EmbeddingClient | null = null;
    expect(() => {
      client = createEmbeddingClient(claudeConfig, { fetch });
    }).not.toThrow();

    expect(client).toBeNull();
    // Construction must NOT have issued any network request.
    expect(calls).toHaveLength(0);
  });
});

/* ── CLI acceptance: platform-managed rejected synchronously ─────────────── */

describe('createEmbeddingClient — rejects platform-managed before network I/O', () => {
  it('throws an LlmError(config_rejected) synchronously and never calls fetch', () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => new Response('{}', { status: 200 }), calls);
    const config = llmProviderConfig.parse({ kind: 'platform-managed' });

    expect(() => createEmbeddingClient(config, { fetch })).toThrow(LlmError);
    // The rejection provably precedes any network call.
    expect(calls).toHaveLength(0);
  });

  it('the thrown error has kind config_rejected', () => {
    let caught: LlmError | undefined;
    try {
      createEmbeddingClient(llmProviderConfig.parse({ kind: 'platform-managed' }), {
        fetch: makeRecorder(() => new Response('{}', { status: 200 }), []),
      });
    } catch (err) {
      caught = err instanceof LlmError ? err : undefined;
    }
    expect(caught?.kind).toBe('config_rejected');
  });
});

/* ── Config validation ───────────────────────────────────────────────────── */

describe('createEmbeddingClient — config validation', () => {
  it('custom with no default model and no override throws config_rejected', () => {
    expect(() =>
      createEmbeddingClient(customConfig, { fetch: makeRecorder(() => new Response('{}', { status: 200 }), []) }),
    ).toThrow(LlmError);
  });

  it('DEFAULT_EMBEDDING_MODELS has the expected values', () => {
    expect(DEFAULT_EMBEDDING_MODELS.openai).toBe('text-embedding-3-small');
    expect(DEFAULT_EMBEDDING_MODELS.openrouter).toBe('openai/text-embedding-3-small');
    expect(DEFAULT_EMBEDDING_MODELS.custom).toBe('');
  });
});

/* ── Empty input ─────────────────────────────────────────────────────────── */

describe('generate — empty input', () => {
  it('returns an empty array without making a network request', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okEmbedding([]), calls);

    const client = createEmbeddingClient(openaiConfig, { fetch });
    const result = await (client as EmbeddingClient).generate([]);

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/* ── Response validation ─────────────────────────────────────────────────── */

describe('generate — response validation', () => {
  it('sorts results by index to preserve input order', async () => {
    // Return vectors in reverse index order; the client must sort them back.
    const v0 = fakeVector();
    const v1 = fakeVector();
    const v2 = fakeVector();

    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { object: 'embedding', index: 2, embedding: v2 },
            { object: 'embedding', index: 0, embedding: v0 },
            { object: 'embedding', index: 1, embedding: v1 },
          ],
          model: 'text-embedding-3-small',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const client = createEmbeddingClient(openaiConfig, { fetch });
    const result = await (client as EmbeddingClient).generate(['a', 'b', 'c']);

    expect(result).toHaveLength(3);
    expect(result[0]!).toEqual(v0);
    expect(result[1]!).toEqual(v1);
    expect(result[2]!).toEqual(v2);
  });

  it('provider_error when result count does not match input count', async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { object: 'embedding', index: 0, embedding: fakeVector() },
          ],
          model: 'text-embedding-3-small',
        }),
        { status: 200 },
      );

    const client = createEmbeddingClient(openaiConfig, { fetch });
    await expect((client as EmbeddingClient).generate(['a', 'b'])).rejects.toMatchObject({
      kind: 'provider_error',
      provider: 'openai',
    });
  });

  it('provider_error when a vector has wrong dimension', async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { object: 'embedding', index: 0, embedding: [0.1, 0.2] }, // only 2 dims
          ],
          model: 'text-embedding-3-small',
        }),
        { status: 200 },
      );

    const client = createEmbeddingClient(openaiConfig, { fetch });
    await expect((client as EmbeddingClient).generate(['a'])).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });

  it('provider_error when a vector element is not a number', async () => {
    const badVector = Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
    badVector[10] = 'not-a-number' as unknown as number;

    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { object: 'embedding', index: 0, embedding: badVector },
          ],
          model: 'text-embedding-3-small',
        }),
        { status: 200 },
      );

    const client = createEmbeddingClient(openaiConfig, { fetch });
    await expect((client as EmbeddingClient).generate(['a'])).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });

  it('provider_error when response data is missing', async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({ object: 'list' }),
        { status: 200 },
      );

    const client = createEmbeddingClient(openaiConfig, { fetch });
    await expect((client as EmbeddingClient).generate(['a'])).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });

  it('provider_error when response is not valid JSON', async () => {
    const fetch: FetchLike = async () =>
      new Response('not json at all', { status: 200 });

    const client = createEmbeddingClient(openaiConfig, { fetch });
    await expect((client as EmbeddingClient).generate(['a'])).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });

  it('provider_error when response embedding is not an array', async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: 'not-an-array' }],
          model: 'text-embedding-3-small',
        }),
        { status: 200 },
      );

    const client = createEmbeddingClient(openaiConfig, { fetch });
    await expect((client as EmbeddingClient).generate(['a'])).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });
});

/* ── HTTP error ──────────────────────────────────────────────────────────── */

describe('generate — HTTP errors', () => {
  it('http_error on non-2xx response, with status but no body content leak', async () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
        }),
      calls,
    );

    const client = createEmbeddingClient(openaiConfig, { fetch });
    await expect((client as EmbeddingClient).generate(['a'])).rejects.toMatchObject({
      kind: 'http_error',
      httpStatus: 429,
      provider: 'openai',
    });
  });
});

/* ── Timeout / abort ─────────────────────────────────────────────────────── */

describe('generate — timeout and abort', () => {
  it('timeout when the response exceeds the default timeout (own abort)', async () => {
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

    const client = createEmbeddingClient(openaiConfig, { fetch, defaultTimeoutMs: 10 });
    await expect((client as EmbeddingClient).generate(['a'])).rejects.toMatchObject({
      kind: 'timeout',
      provider: 'openai',
    });
  });

  it('aborted when fetch rejects with AbortError but signal is not our timeout', async () => {
    const fetch: FetchLike = async () => {
      const err = new Error('aborted externally');
      err.name = 'AbortError';
      throw err;
    };

    const client = createEmbeddingClient(openaiConfig, { fetch, defaultTimeoutMs: 60_000 });
    await expect((client as EmbeddingClient).generate(['a'])).rejects.toMatchObject({
      kind: 'aborted',
      provider: 'openai',
    });
  });
});

/* ── Error redaction (§5.3) ──────────────────────────────────────────────── */

describe('generate — error redaction (§5.3)', () => {
  it('an http_error never contains the api key or input text', async () => {
    const secretBody = `{"error":"boom","key":"${API_KEYS.openai}","leaked":"<private>sensitive</private>"}`;
    const fetch = makeRecorder(() => new Response(secretBody, { status: 500 }), []);

    const client = createEmbeddingClient(openaiConfig, { fetch });

    let caught: LlmError | undefined;
    try {
      await (client as EmbeddingClient).generate(['sensitive input text']);
    } catch (err) {
      caught = err instanceof LlmError ? err : undefined;
    }
    expect(caught?.kind).toBe('http_error');
    expect(caught?.cause).toBeUndefined();
    const serialized = JSON.stringify(caught ?? {});
    expect(serialized).not.toContain(API_KEYS.openai);
    expect(serialized).not.toContain('<private>');
    expect(serialized).not.toContain('sensitive input text');
    expect(serialized).not.toContain('boom');
    expect(caught?.httpStatus).toBe(500);
    expect(Object.getOwnPropertyDescriptor(caught, 'cause')).toBeUndefined();
  });

  it('a provider_error never carries the raw provider payload or input text', async () => {
    const fetch = makeRecorder(
      () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { object: 'embedding', index: 0, embedding: `leaked-key-${API_KEYS.openai}` },
            ],
            model: 'text-embedding-3-small',
          }),
          { status: 200 },
        ),
      [],
    );

    const client = createEmbeddingClient(openaiConfig, { fetch });

    let caught: LlmError | undefined;
    try {
      await (client as EmbeddingClient).generate(['private query']);
    } catch (err) {
      caught = err instanceof LlmError ? err : undefined;
    }
    expect(caught?.kind).toBe('provider_error');
    expect(caught?.cause).toBeUndefined();
    const serialized = JSON.stringify(caught ?? {});
    expect(serialized).not.toContain(API_KEYS.openai);
    expect(serialized).not.toContain('private query');
    expect(Object.getOwnPropertyDescriptor(caught, 'cause')).toBeUndefined();
  });
});

/* ── Factory does not call fetch synchronously ──────────────────────────── */

describe('createEmbeddingClient — lazy construction', () => {
  it('does not issue any network request during client construction', () => {
    const calls: Captured[] = [];
    const fetch = makeRecorder(() => okEmbedding([fakeVector()]), calls);

    createEmbeddingClient(openaiConfig, { fetch });
    expect(calls).toHaveLength(0);
  });
});

/* ── EMBEDDING_DIMENSION exported correctly ─────────────────────────────── */

describe('EMBEDDING_DIMENSION', () => {
  it('is 1536 per AGENTS.md §4', () => {
    expect(EMBEDDING_DIMENSION).toBe(1536);
  });
});
