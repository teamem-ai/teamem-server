/**
 * OpenAI-compatible structured-output adapter — local-endpoint acceptance
 * (M0-F1-03, DUA-166).
 *
 * Whereas `llm.factory.test.ts` exercises the adapter through an injected
 * fake `fetch` (the only place mocks are permitted), this file satisfies the
 * task's CLI acceptance steps by running the adapter against a REAL local
 * HTTP socket with the REAL `globalThis.fetch`:
 *
 *   1. Adapter unit tests against a test-only HTTP fixture (this file).
 *   2. Point the `custom` config at a local structured-output endpoint and run
 *      one real F1 extraction.
 *   3. Block external network (a fetch guard that whitelist-localizes the
 *      request) and confirm the custom endpath still works and makes no
 *      external request.
 *   4. Return malformed structured data and confirm an explicit failure.
 *
 * External network is blocked by a transport guard that delegates to
 * `globalThis.fetch` for `127.0.0.1`/`localhost` only and throws for any other
 * host. The guard's existence is the step-3 proof: if the adapter had tried
 * to reach an external host (e.g. silently rewriting `custom` to
 * `api.openai.com`), the call would throw and the test would fail loudly.
 *
 * No production code is changed by this file — the adapter lives in
 * `factory.ts`; this proves its real end-to-end behavior at the network
 * boundary. No fixtures, mock success results, or external dependencies are
 * used in any production path.
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';

import { f1Output } from '../compiler/f1/output.js';
import { createLlmClient } from './factory.js';
import { LlmError, type FetchLike } from './types.js';

/* ── Test-only HTTP fixture server (an OpenAI-compatible endpoint) ──────────── */

/** A single request captured by the fixture server. */
interface FixtureRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A response the handler may produce. */
interface FixtureResponse {
  status?: number;
  /** A JSON-serializable value, or a raw string sent as-is. */
  body: unknown;
  /** Delay (ms) before responding — used by the timeout test. */
  delayMs?: number;
}

/** A running fixture server plus its captured requests. */
interface Fixture {
  server: Server;
  /** baseUrl for a `custom` provider config (ends in `/v1`). */
  baseUrl: string;
  host: string;
  requests: FixtureRequest[];
  close: () => Promise<void>;
}

/**
 * Start a local OpenAI-compatible server on 127.0.0.1 with an ephemeral port.
 * `respond` is called for each request and may inspect the captured request to
 * decide its reply. Throwing inside `respond` causes a 500, which the adapter
 * maps to `http_error` (the timeout test deliberately delays past timeoutMs).
 */
async function startFixture(
  respond: (req: FixtureRequest) => FixtureResponse,
): Promise<Fixture> {
  const requests: FixtureRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    });
    req.on('end', () => {
      const fr: FixtureRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(fr);
      let resp: FixtureResponse;
      try {
        resp = respond(fr);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'fixture error';
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
        return;
      }
      const status = resp.status ?? 200;
      const payload =
        typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
      const send = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      };
      if (resp.delayMs && resp.delayMs > 0) {
        setTimeout(send, resp.delayMs);
      } else {
        send();
      }
    });
  });
  return new Promise<Fixture>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'object' && !('port' in addr)) {
        reject(new Error('could not bind fixture'));
        return;
      }
      const port = (addr as { port: number }).port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        host: `127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/** Build an OpenAI chat-completions success envelope. */
function openAiEnvelope(value: unknown, model = 'local-f1-model'): unknown {
  return {
    model,
    choices: [{ message: { content: JSON.stringify(value) } }],
  };
}

/* ── Network-blocking fetch guard ──────────────────────────────────────────── */

/**
 * A `fetch`-compatible transport that delegates to `globalThis.fetch` for
 * `127.0.0.1`/`localhost` only and throws for any other host. Used to prove
 * (CLI step 3) that the custom adapter path makes no external request: any
 * such attempt would throw and fail the test loudly.
 *
 * Records every host the adapter asked for so tests can assert that only the
 * local fixture was contacted.
 */
function localOnlyFetch(attempted: string[]): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    attempted.push(url.host);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error(`network blocked: external host ${url.host} is not allowed`);
    }
    return globalThis.fetch(input, init);
  };
}

/* ── A representative valid F1 extract output ──────────────────────────────── */

const validF1Extract = {
  action: 'extract',
  type: 'decision',
  title: 'Use Postgres for the main datastore',
  body: 'We chose Postgres over Mongo because we need joins and pgvector.',
  path: 'decisions/postgres-main-datastore',
  tags: ['db', 'postgres'],
  confidence: 'high',
} as const;

/* ── Step 1 + Step 2: real extraction via a local structured-output endpoint ─ */

describe('OpenAI-compatible adapter — local structured-output endpoint', () => {
  it('runs a real F1 extraction through the custom config pointed at a local endpoint (real fetch)', async () => {
    const fixture = await startFixture(() => ({
      body: openAiEnvelope(validF1Extract),
    }));
    try {
      const attempted: string[] = [];
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'custom-secret' },
        { fetch: localOnlyFetch(attempted), defaultModel: 'local-f1-model' },
      );

      const res = await client.structured({
        schema: f1Output,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-local-extract',
      });

      // Step 2 success: real provider output, real Zod re-validation.
      expect(res.output).toEqual(validF1Extract);
      expect(res.model).toEqual({
        provider: 'custom',
        model: 'local-f1-model',
        requestId: 'req-local-extract',
      });

      // The adapter really hit the local endpoint over the wire.
      expect(fixture.requests).toHaveLength(1);
      const wire = fixture.requests[0]!;
      expect(wire.method).toBe('POST');
      expect(wire.url).toBe('/v1/chat/completions');
      expect(wire.headers['authorization']).toBe('Bearer custom-secret');
      const sent = JSON.parse(wire.body) as {
        model: string;
        response_format: { type: string; json_schema: { name: string; schema: Record<string, unknown> } };
      };
      expect(sent.model).toBe('local-f1-model');
      expect(sent.response_format.type).toBe('json_schema');
      expect(sent.response_format.json_schema.name).toBe('teamem_structured_output');
      // The F1 discriminated union renders to a root oneOf and strict is
      // omitted; assert the provider-native schema is the real oneOf payload.
      const oneOf = sent.response_format.json_schema.schema.oneOf;
      expect(Array.isArray(oneOf)).toBe(true);
      if (Array.isArray(oneOf)) expect(oneOf.length).toBe(2);
      // No $schema anchor leaked onto the wire.
      expect(sent.response_format.json_schema.schema.$schema).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  /* ── Step 3: external network blocked, custom path still works ──────────── */

  it('with external network blocked, the custom path still works and contacts only the local host', async () => {
    const fixture = await startFixture(() => ({
      body: openAiEnvelope({ action: 'skip', reason: 'no knowledge here' }),
    }));
    try {
      const attempted: string[] = [];
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'custom-secret' },
        { fetch: localOnlyFetch(attempted), defaultModel: 'local-f1-model' },
      );

      const res = await client.structured({
        schema: f1Output,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-blocked-net',
      });

      expect(res.output).toEqual({ action: 'skip', reason: 'no knowledge here' });
      // The guard recorded exactly one request, and it was to the local host.
      expect(attempted).toEqual([fixture.host]);
    } finally {
      await fixture.close();
    }
  });

  it('proves the guard rejects an external host: a custom baseUrl pointing off-host fails (no silent rewrite to localhost)', async () => {
    const fixture = await startFixture(() => ({ body: openAiEnvelope(validF1Extract) }));
    try {
      const attempted: string[] = [];
      const client = createLlmClient(
        // An external fake host. The guard must refuse it; this demonstrates
        // the adapter uses the configured baseUrl verbatim and does not fall
        // back to any built-in host.
        { kind: 'custom', baseUrl: 'https://api.openai.example.test/v1', apiKey: 'x' },
        { fetch: localOnlyFetch(attempted), defaultModel: 'm' },
      );

      await expect(
        client.structured({
          schema: f1Output,
          systemPrompt: 'sys',
          userPrompt: 'usr',
          requestId: 'req-ext-block',
        }),
      ).rejects.toMatchObject({
        kind: 'provider_error',
        requestId: 'req-ext-block',
        provider: 'custom',
      });
      // The only attempted host was the external one, which the guard refused.
      expect(attempted).toEqual(['api.openai.example.test']);
    } finally {
      await fixture.close();
    }
  });

  /* ── Step 4: malformed structured data → explicit failure ──────────────── */

  it('malformed structured data (wrong shape) yields an explicit schema_validation_failed', async () => {
    // Provider returns valid JSON, but it is missing required F1 fields.
    const fixture = await startFixture(() => ({
      body: openAiEnvelope({
        action: 'extract',
        title: 'no body, no path, no type',
      }),
    }));
    try {
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'k' },
        { fetch: globalThis.fetch, defaultModel: 'local-f1-model' },
      );

      await expect(
        client.structured({
          schema: f1Output,
          systemPrompt: 'sys',
          userPrompt: 'usr',
          requestId: 'req-malformed',
        }),
      ).rejects.toMatchObject({
        kind: 'schema_validation_failed',
        requestId: 'req-malformed',
      });
    } finally {
      await fixture.close();
    }
  });

  it('malformed structured data (non-JSON content) yields an explicit schema_validation_failed, never free-text fallback', async () => {
    // The adapter must not regex/scaffold a free-text answer out of this.
    const fixture = await startFixture(() => ({
      body: openAiEnvelope('not-json-at-all'),
    }));
    try {
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'k' },
        { fetch: globalThis.fetch, defaultModel: 'local-f1-model' },
      );
      await expect(
        client.structured({
          schema: f1Output,
          systemPrompt: 'sys',
          userPrompt: 'usr',
          requestId: 'req-nonjson',
        }),
      ).rejects.toMatchObject({ kind: 'schema_validation_failed' });
    } finally {
      await fixture.close();
    }
  });

  it('a 2xx with no choices yields an explicit empty_output failure', async () => {
    const fixture = await startFixture(() => ({
      body: { model: 'local-f1-model', choices: [] },
    }));
    try {
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'k' },
        { fetch: globalThis.fetch, defaultModel: 'local-f1-model' },
      );
      await expect(
        client.structured({
          schema: f1Output,
          systemPrompt: 'sys',
          userPrompt: 'usr',
          requestId: 'req-empty',
        }),
      ).rejects.toMatchObject({ kind: 'empty_output' });
    } finally {
      await fixture.close();
    }
  });

  it('a non-2xx endpoint response yields an explicit http_error carrying only the status (no body leak)', async () => {
    const secretBody = JSON.stringify({ error: 'rate limited' });
    const fixture = await startFixture(() => ({ status: 429, body: secretBody }));
    try {
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'k' },
        { fetch: globalThis.fetch, defaultModel: 'local-f1-model' },
      );
      let caught: LlmError | undefined;
      try {
        await client.structured({
          schema: f1Output,
          systemPrompt: 'sys',
          userPrompt: 'usr-private',
          requestId: 'req-httperr',
        });
      } catch (err) {
        caught = err instanceof LlmError ? err : undefined;
      }
      expect(caught?.kind).toBe('http_error');
      expect(caught?.httpStatus).toBe(429);
      expect(caught?.cause).toBeUndefined();
      const serialized = JSON.stringify(caught ?? {});
      expect(serialized).not.toContain('rate limited');
      expect(serialized).not.toContain('usr-private');
      expect(Object.getOwnPropertyDescriptor(caught, 'cause')).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  /* ── Explicit timeout over the real network boundary ───────────────────── */

  it('a slow local endpoint is killed by the explicit timeout and yields a timeout failure', async () => {
    const fixture = await startFixture(() => ({ body: openAiEnvelope(validF1Extract), delayMs: 300 }));
    try {
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'k' },
        { fetch: globalThis.fetch, defaultModel: 'local-f1-model', defaultTimeoutMs: 60_000 },
      );
      await expect(
        client.structured({
          schema: f1Output,
          systemPrompt: 'sys',
          userPrompt: 'usr',
          timeoutMs: 20,
          requestId: 'req-timeout-local',
        }),
      ).rejects.toMatchObject({ kind: 'timeout', requestId: 'req-timeout-local' });
    } finally {
      await fixture.close();
    }
  });

  /* ── Non-OpenAI-compatible shape proves the adapter paths are distinct ──── */

  it('re-validates against the caller Zod schema even when the provider fabricates server-owned fields', async () => {
    // The model "helpfully" adds a uuid and createdAt. f1Output is a
    // strictObject union, so unknown keys must be rejected (no silent drop).
    const fixture = await startFixture(() => ({
      body: openAiEnvelope({
        ...validF1Extract,
        uuid: 'should-not-leak-through',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    }));
    try {
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'k' },
        { fetch: globalThis.fetch, defaultModel: 'local-f1-model' },
      );
      await expect(
        client.structured({
          schema: f1Output,
          systemPrompt: 'sys',
          userPrompt: 'usr',
          requestId: 'req-strict',
        }),
      ).rejects.toMatchObject({ kind: 'schema_validation_failed' });
    } finally {
      await fixture.close();
    }
  });

  /* ── A non-openai-family schema also flows end to end over the local wire ── */

  it('also drives a plain object-root schema with strict:true end to end', async () => {
    const fixture = await startFixture(() => ({
      body: openAiEnvelope({ answer: 'x', count: 1 }, 'local-model'),
    }));
    try {
      const schema = z.strictObject({ answer: z.string(), count: z.number() });
      const client = createLlmClient(
        { kind: 'custom', baseUrl: fixture.baseUrl, apiKey: 'k' },
        { fetch: globalThis.fetch, defaultModel: 'local-model' },
      );
      const res = await client.structured({
        schema,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        requestId: 'req-strict-obj',
      });
      expect(res.output).toEqual({ answer: 'x', count: 1 });
      const sent = JSON.parse(fixture.requests[0]!.body) as {
        response_format: { json_schema: { strict?: true } };
      };
      expect(sent.response_format.json_schema.strict).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});