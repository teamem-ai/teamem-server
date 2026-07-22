/**
 * OpenAI-compatible embedding adapter tests (M1-EMB-02).
 *
 * These tests exercise the embedding adapter's responsibilities:
 *   1. Building correct requests (URL, headers, body) for each provider.
 *   2. Executing the full HTTP call with timeout/abort orchestration via
 *      an injected fake fetch.
 *   3. Parsing responses: extracting `data[].embedding`, validating
 *      dimensions (must be exactly 1536), preserving input order.
 *   4. Redacting error surfaces — no API key, request body, or provider
 *      payload leaks via error messages.
 *
 * Success paths:
 *   - Single input → single 1536-d vector
 *   - Multiple inputs → multiple 1536-d vectors, order preserved
 *   - Empty inputs → empty result, no network call
 *   - Results sorted by index regardless of response ordering
 *
 * Failure paths:
 *   - Vector with wrong dimension (≠1536) → provider_error
 *   - Non-number vector element → provider_error
 *   - Mismatched vector count → provider_error
 *   - Missing data array → provider_error
 *   - Non-JSON response → provider_error
 *   - HTTP error (non-2xx) → http_error with status
 *   - Timeout → timeout
 *   - External abort → aborted
 *
 * Security/boundary counterexamples:
 *   - Error surfaces never contain API keys or input text
 *   - HTTP error body is drained but never retained
 *   - No `cause` attached to LlmError
 *
 * CLI acceptance steps:
 *   1. Fake fetch with valid embedding → request body contains all inputs,
 *      vectors ordered correctly, dim=1536.
 *   2. Fake response with dim≠1536 → explicit error, not accepted.
 *   3. (Optional) Real embedding endpoint.
 */
import { describe, expect, it } from 'vitest';

import type { ResolvedLlmConfig } from '../../config/llm.js';
import { LlmError, type FetchLike } from '../types.js';
import { EMBEDDING_DIMENSION } from './port.js';
import {
  DEFAULT_EMBEDDING_MODELS,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  callEmbeddingApi,
  embeddingEndpoint,
  parseOpenAiEmbeddingResponse,
} from './openai-compatible.adapter.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a valid embedding vector of the expected dimension. */
function fakeVector(dim: number = EMBEDDING_DIMENSION): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(i * 0.1));
}

/** Build a valid OpenAI-compatible embeddings response. */
function okEmbedding(
  vectors: number[][],
  model = 'text-embedding-3-small',
): Response {
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

/** A captured request, surfaced to tests via a fake fetch. */
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
    const captured: Captured = {
      url: input,
      method: init?.method ?? 'GET',
      headers,
      body,
    };
    calls.push(captured);
    return respond(captured);
  };
}

// ── endpoint resolution ─────────────────────────────────────────────────────

describe('embeddingEndpoint', () => {
  it('returns OpenAI embeddings URL', () => {
    const config = { kind: 'openai' as const, apiKey: 'k' } as ResolvedLlmConfig;
    expect(embeddingEndpoint(config)).toBe(`${OPENAI_BASE_URL}/embeddings`);
  });

  it('returns OpenRouter embeddings URL', () => {
    const config = { kind: 'openrouter' as const, apiKey: 'k' } as ResolvedLlmConfig;
    expect(embeddingEndpoint(config)).toBe(`${OPENROUTER_BASE_URL}/embeddings`);
  });

  it('returns custom baseUrl + /embeddings, stripping trailing slashes', () => {
    const config = {
      kind: 'custom' as const,
      baseUrl: 'https://internal.test/v1///',
      apiKey: 'k',
    } as ResolvedLlmConfig;
    expect(embeddingEndpoint(config)).toBe('https://internal.test/v1/embeddings');
  });

  it('returns custom baseUrl without trailing slashes untouched', () => {
    const config = {
      kind: 'custom' as const,
      baseUrl: 'https://embeddings.example.com/v1',
      apiKey: 'k',
    } as ResolvedLlmConfig;
    expect(embeddingEndpoint(config)).toBe('https://embeddings.example.com/v1/embeddings');
  });
});

// ── DEFAULT_EMBEDDING_MODELS ────────────────────────────────────────────────

describe('DEFAULT_EMBEDDING_MODELS', () => {
  it('has the expected model identifiers', () => {
    expect(DEFAULT_EMBEDDING_MODELS.openai).toBe('text-embedding-3-small');
    expect(DEFAULT_EMBEDDING_MODELS.openrouter).toBe('openai/text-embedding-3-small');
    expect(DEFAULT_EMBEDDING_MODELS.custom).toBe('');
  });
});

// ── callEmbeddingApi — success paths ────────────────────────────────────────

describe('callEmbeddingApi — success paths', () => {
  it('returns a 1536-d vector for a single input (CLI step 1)', async () => {
    const inputs = ['hello world'];
    const vectors = [fakeVector()];
    const calls: Captured[] = [];
    const fetchFn = makeRecorder(() => okEmbedding(vectors), calls);

    const result = await callEmbeddingApi({
      provider: 'openai',
      url: `${OPENAI_BASE_URL}/embeddings`,
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      timeoutMs: 30_000,
      fetchFn,
      inputs,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(EMBEDDING_DIMENSION);
    expect(result[0]).toEqual(vectors[0]);

    // CLI step 1: request body contains all input texts.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${OPENAI_BASE_URL}/embeddings`);
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-test');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['hello world'],
      encoding_format: 'float',
    });
  });

  it('returns 1536-d vectors for multiple inputs, order preserved (CLI step 1)', async () => {
    const inputs = ['first', 'second', 'third'];
    const v0 = fakeVector();
    const v1 = fakeVector();
    const v2 = fakeVector();
    const calls: Captured[] = [];
    const fetchFn = makeRecorder(() => okEmbedding([v0, v1, v2]), calls);

    const result = await callEmbeddingApi({
      provider: 'openai',
      url: `${OPENAI_BASE_URL}/embeddings`,
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      timeoutMs: 30_000,
      fetchFn,
      inputs,
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(v0);
    expect(result[1]).toEqual(v1);
    expect(result[2]).toEqual(v2);
    // All vectors are 1536-d.
    for (const vec of result) {
      expect(vec).toHaveLength(EMBEDDING_DIMENSION);
    }

    // Body contains all inputs in a single request (batch).
    expect(calls[0]!.body).toMatchObject({ input: inputs });
  });

  it('sorts results by index to preserve input order regardless of response ordering', async () => {
    const v0 = fakeVector();
    const v1 = fakeVector();
    const v2 = fakeVector();

    const fetchFn: FetchLike = async () =>
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

    const result = await callEmbeddingApi({
      provider: 'openai',
      url: `${OPENAI_BASE_URL}/embeddings`,
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      timeoutMs: 30_000,
      fetchFn,
      inputs: ['a', 'b', 'c'],
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(v0);
    expect(result[1]).toEqual(v1);
    expect(result[2]).toEqual(v2);
  });

  it('returns empty array for empty inputs, never makes a network call', async () => {
    const calls: Captured[] = [];
    const fetchFn = makeRecorder(() => okEmbedding([]), calls);

    const result = await callEmbeddingApi({
      provider: 'openai',
      url: `${OPENAI_BASE_URL}/embeddings`,
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      timeoutMs: 30_000,
      fetchFn,
      inputs: [],
    });

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('OpenRouter: adds X-Title header', async () => {
    const calls: Captured[] = [];
    const fetchFn = makeRecorder(
      () => okEmbedding([fakeVector()], 'openai/text-embedding-3-small'),
      calls,
    );

    await callEmbeddingApi({
      provider: 'openrouter',
      url: `${OPENROUTER_BASE_URL}/embeddings`,
      apiKey: 'sk-or-test',
      model: 'openai/text-embedding-3-small',
      timeoutMs: 30_000,
      fetchFn,
      inputs: ['one'],
    });

    expect(calls[0]!.headers['X-Title']).toBe('teamem');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-or-test');
    expect(calls[0]!.body).toMatchObject({ model: 'openai/text-embedding-3-small' });
  });

  it('custom: uses the provided model and api key', async () => {
    const calls: Captured[] = [];
    const fetchFn = makeRecorder(
      () => okEmbedding([fakeVector()], 'internal-emb-model'),
      calls,
    );

    await callEmbeddingApi({
      provider: 'custom',
      url: 'https://internal.example.test/v1/embeddings',
      apiKey: 'internal-key',
      model: 'internal-emb-model',
      timeoutMs: 30_000,
      fetchFn,
      inputs: ['x'],
    });

    expect(calls[0]!.url).toBe('https://internal.example.test/v1/embeddings');
    expect(calls[0]!.headers['authorization']).toBe('Bearer internal-key');
    expect(calls[0]!.body).toMatchObject({ model: 'internal-emb-model' });
  });
});

// ── callEmbeddingApi — HTTP errors ──────────────────────────────────────────

describe('callEmbeddingApi — HTTP errors', () => {
  it('returns http_error on non-2xx with status but no body leak', async () => {
    const secretBody = JSON.stringify({ error: { message: 'rate limited' } });
    const fetchFn: FetchLike = async () =>
      new Response(secretBody, { status: 429 });

    await expect(
      callEmbeddingApi({
        provider: 'openai',
        url: `${OPENAI_BASE_URL}/embeddings`,
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
        timeoutMs: 30_000,
        fetchFn,
        inputs: ['a'],
      }),
    ).rejects.toMatchObject({ kind: 'http_error', httpStatus: 429, provider: 'openai' });
  });

  it('http_error never contains api key or input text', async () => {
    const secretBody = `{"error":"boom","key":"sk-leaked-key"}`;
    const fetchFn: FetchLike = async () =>
      new Response(secretBody, { status: 500 });

    let caught: LlmError | undefined;
    try {
      await callEmbeddingApi({
        provider: 'openai',
        url: `${OPENAI_BASE_URL}/embeddings`,
        apiKey: 'sk-secret',
        model: 'text-embedding-3-small',
        timeoutMs: 30_000,
        fetchFn,
        inputs: ['private query text'],
      });
    } catch (err) {
      caught = err instanceof LlmError ? err : undefined;
    }

    expect(caught?.kind).toBe('http_error');
    expect(caught?.cause).toBeUndefined();
    const serialized = JSON.stringify(caught ?? {});
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('sk-leaked-key');
    expect(serialized).not.toContain('private query text');
    expect(serialized).not.toContain('boom');
    expect(Object.getOwnPropertyDescriptor(caught, 'cause')).toBeUndefined();
  });
});

// ── callEmbeddingApi — timeout / abort ──────────────────────────────────────

describe('callEmbeddingApi — timeout and abort', () => {
  it('timeout when response exceeds timeoutMs (own abort signal)', async () => {
    const fetchFn: FetchLike = async (_input, init) => {
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

    await expect(
      callEmbeddingApi({
        provider: 'openai',
        url: `${OPENAI_BASE_URL}/embeddings`,
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
        timeoutMs: 10,
        fetchFn,
        inputs: ['a'],
      }),
    ).rejects.toMatchObject({ kind: 'timeout', provider: 'openai' });
  });

  it('aborted when fetch rejects with AbortError but signal not from our timeout', async () => {
    const fetchFn: FetchLike = async () => {
      const err = new Error('aborted externally');
      err.name = 'AbortError';
      throw err;
    };

    await expect(
      callEmbeddingApi({
        provider: 'openai',
        url: `${OPENAI_BASE_URL}/embeddings`,
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
        timeoutMs: 60_000,
        fetchFn,
        inputs: ['a'],
      }),
    ).rejects.toMatchObject({ kind: 'aborted', provider: 'openai' });
  });
});

// ── parseOpenAiEmbeddingResponse — success paths ────────────────────────────

describe('parseOpenAiEmbeddingResponse — success paths', () => {
  it('parses a valid single-vector response', () => {
    const v = fakeVector();
    const raw = JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: v }],
      model: 'text-embedding-3-small',
    });

    const result = parseOpenAiEmbeddingResponse('openai', raw, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(v);
  });

  it('parses a valid multi-vector response', () => {
    const v0 = fakeVector();
    const v1 = fakeVector();
    const raw = JSON.stringify({
      object: 'list',
      data: [
        { object: 'embedding', index: 0, embedding: v0 },
        { object: 'embedding', index: 1, embedding: v1 },
      ],
      model: 'text-embedding-3-small',
    });

    const result = parseOpenAiEmbeddingResponse('openai', raw, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(v0);
    expect(result[1]).toEqual(v1);
  });

  it('handles integer-typed index (index: 0 not "0")', () => {
    const v = fakeVector();
    const raw = JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: v }],
    });

    const result = parseOpenAiEmbeddingResponse('openai', raw, 1);
    expect(result).toHaveLength(1);
  });
});

// ── parseOpenAiEmbeddingResponse — failure paths ────────────────────────────

describe('parseOpenAiEmbeddingResponse — failure paths', () => {
  it('provider_error on non-JSON response body (CLI step 2)', () => {
    expect(() =>
      parseOpenAiEmbeddingResponse('openai', 'not valid json {{{', 1),
    ).toThrow(LlmError);

    try {
      parseOpenAiEmbeddingResponse('openai', 'not valid json {{{', 1);
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      const llmErr = err as LlmError;
      expect(llmErr.kind).toBe('provider_error');
      expect(llmErr.provider).toBe('openai');
    }
  });

  it('provider_error on non-object JSON (string)', () => {
    expect(() =>
      parseOpenAiEmbeddingResponse('openai', '"just a string"', 1),
    ).toThrow(LlmError);
  });

  it('provider_error on non-object JSON (array)', () => {
    expect(() =>
      parseOpenAiEmbeddingResponse('openai', '[1,2,3]', 1),
    ).toThrow(LlmError);
  });

  it('provider_error when data field is missing', () => {
    expect(() =>
      parseOpenAiEmbeddingResponse('openai', JSON.stringify({ object: 'list' }), 1),
    ).toThrow(LlmError);
  });

  it('provider_error when data field is not an array', () => {
    expect(() =>
      parseOpenAiEmbeddingResponse(
        'openai',
        JSON.stringify({ object: 'list', data: 'not-array' }),
        1,
      ),
    ).toThrow(LlmError);
  });

  it('provider_error when an item has no embedding field', () => {
    expect(() =>
      parseOpenAiEmbeddingResponse(
        'openai',
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0 }],
        }),
        1,
      ),
    ).toThrow(LlmError);
  });

  it('provider_error when embedding is not an array', () => {
    expect(() =>
      parseOpenAiEmbeddingResponse(
        'openai',
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: 'not-an-array' }],
        }),
        1,
      ),
    ).toThrow(LlmError);
  });

  it('provider_error when vector dimension ≠ 1536 (CLI step 2 — explicit reject)', async () => {
    // Wrong dimension: only 2 elements instead of 1536.
    const fetchFn: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          model: 'text-embedding-3-small',
        }),
        { status: 200 },
      );

    await expect(
      callEmbeddingApi({
        provider: 'openai',
        url: `${OPENAI_BASE_URL}/embeddings`,
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
        timeoutMs: 30_000,
        fetchFn,
        inputs: ['a'],
      }),
    ).rejects.toMatchObject({ kind: 'provider_error', provider: 'openai' });
  });

  it('provider_error when a vector element is not a number', async () => {
    const badVector = Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
    badVector[10] = 'not-a-number' as unknown as number;

    const fetchFn: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: badVector }],
          model: 'text-embedding-3-small',
        }),
        { status: 200 },
      );

    await expect(
      callEmbeddingApi({
        provider: 'openai',
        url: `${OPENAI_BASE_URL}/embeddings`,
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
        timeoutMs: 30_000,
        fetchFn,
        inputs: ['a'],
      }),
    ).rejects.toMatchObject({ kind: 'provider_error' });
  });

  it('provider_error when result count ≠ expected count', async () => {
    const fetchFn: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: fakeVector() }],
          model: 'text-embedding-3-small',
        }),
        { status: 200 },
      );

    await expect(
      callEmbeddingApi({
        provider: 'openai',
        url: `${OPENAI_BASE_URL}/embeddings`,
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
        timeoutMs: 30_000,
        fetchFn,
        inputs: ['a', 'b'], // expected 2, got 1
      }),
    ).rejects.toMatchObject({ kind: 'provider_error' });
  });
});

// ── Security / redaction boundary ───────────────────────────────────────────

describe('callEmbeddingApi — error redaction (§5.3)', () => {
  it('provider_error never carries raw provider payload, api key, or input text', async () => {
    const fetchFn: FetchLike = async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            {
              object: 'embedding',
              index: 0,
              embedding: `leaked-key-sk-secret-abc`,
            },
          ],
          model: 'text-embedding-3-small',
        }),
        { status: 200 },
      );

    let caught: LlmError | undefined;
    try {
      await callEmbeddingApi({
        provider: 'openai',
        url: `${OPENAI_BASE_URL}/embeddings`,
        apiKey: 'sk-secret-abc',
        model: 'text-embedding-3-small',
        timeoutMs: 30_000,
        fetchFn,
        inputs: ['private sensitive search query'],
      });
    } catch (err) {
      caught = err instanceof LlmError ? err : undefined;
    }

    expect(caught?.kind).toBe('provider_error');
    expect(caught?.cause).toBeUndefined();
    const serialized = JSON.stringify(caught ?? {});
    expect(serialized).not.toContain('sk-secret-abc');
    expect(serialized).not.toContain('private sensitive search query');
    expect(serialized).not.toContain('leaked-key');
    expect(Object.getOwnPropertyDescriptor(caught, 'cause')).toBeUndefined();
  });

  it('error message does not contain api key even if the key text appears in error', () => {
    try {
      parseOpenAiEmbeddingResponse('openai', 'sk-leaked-key-in-body', 1);
    } catch (err) {
      const llmErr = err as LlmError;
      expect(llmErr.message).not.toContain('sk-leaked');
    }
  });
});

// ── Adapter does not call fetch on construction ────────────────────────────

describe('callEmbeddingApi — lazy behavior', () => {
  it('does not use fetch when inputs array is empty', async () => {
    const calls: Captured[] = [];
    const fetchFn = makeRecorder(() => new Response('{}', { status: 200 }), calls);

    await callEmbeddingApi({
      provider: 'openai',
      url: `${OPENAI_BASE_URL}/embeddings`,
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      timeoutMs: 30_000,
      fetchFn,
      inputs: [],
    });

    expect(calls).toHaveLength(0);
  });
});
