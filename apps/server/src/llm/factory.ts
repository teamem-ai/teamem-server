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
 *     Strict mode is requested only when the derived schema is strict-
 *     compatible (root object, no anyOf/oneOf/$ref). The authoritative
 *     guarantee always comes from the mandatory Zod re-validation (§5.2).
 *
 * Every adapter does the same three things around the native mechanism, so the
 * compiler does not branch on provider:
 *   1. Convert the caller's Zod schema to JSON Schema via `z.toJSONSchema` and
 *      normalize it to the root-object shape every provider requires
 *      (see {@link toProviderSchema}).
 *   2. Send that schema to the provider (§5.2: provider-native structured
 *      output).
 *   3. Re-parse and re-validate the provider's JSON payload with the same
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
  MAX_OUTPUT_TOKENS,
  type FetchLike,
  type LlmClient,
  type LlmClientDeps,
  type LlmProviderKind,
} from './types.js';
import {
  ANTHROPIC_BASE_URL,
  CLAUDE_DEFAULT_MODEL,
  buildClaudeRequest,
  parseClaudeResponse,
} from './claude-adapter.js';

export { LlmError } from './types.js';
export type {
  FetchLike,
  LlmClient,
  LlmClientDeps,
  LlmProviderKind,
  ModelMetadata,
} from './types.js';

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
  claude: CLAUDE_DEFAULT_MODEL,
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
    throw new LlmError('config_rejected', 'custom', '');
  }

  const resolved: ResolvedLlmConfig = config;
  const provider = resolved.kind;
  const model = deps.defaultModel ?? DEFAULT_MODELS[provider];
  if (!model) {
    throw new LlmError('config_rejected', provider, '');
  }

  const timeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new LlmError('config_rejected', provider, '');
  }

  return {
    structured: (request) =>
      runStructured(provider, resolved, model, timeoutMs, fetchFn, request),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Core call path                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Redact secrets and bound the length of a string before it is logged. Strips
 * Bearer tokens and `sk_`/`tok_`/`tm_`-style keys, and caps the length.
 */
function scrubForDebug(s: string): string {
  return s
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|tok|tm)[_-][A-Za-z0-9_-]+/g, '$1_[REDACTED]')
    .slice(0, 800);
}

/**
 * Opt-in diagnostic log for LLM failures. OFF by default — the compiler stays
 * quiet and leaks nothing (§5.3). When TEAMEM_LLM_DEBUG is set, the underlying
 * cause of an otherwise-opaque provider_error / http_error is written to the
 * worker log (secrets scrubbed, length-bounded) so a self-hoster can see WHY a
 * compile failed. It never includes the ingested payload — only the provider's
 * error message / response snippet.
 */
function logLlmDebug(
  provider: string,
  requestId: string,
  kind: string,
  detail: string,
): void {
  if (!process.env['TEAMEM_LLM_DEBUG']) return;
  console.warn(
    JSON.stringify({
      event: 'llm_debug',
      provider,
      requestId,
      kind,
      detail: scrubForDebug(detail),
    }),
  );
}

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
    const providerSchema = toProviderSchema(z.toJSONSchema(request.schema));
    const { url, init } = buildRequest(
      config,
      model,
      request.systemPrompt,
      request.userPrompt,
      providerSchema.schema,
      controller.signal,
    );

    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlmError('timeout', provider, request.requestId);
      }
      throw new LlmError(abortedKind(err), provider, request.requestId);
    }

    if (!response.ok) {
      if (process.env['TEAMEM_LLM_DEBUG']) {
        // Debug only: capture the provider's error body (bounded, scrubbed).
        let body = '';
        try {
          body = await response.text();
        } catch {
          /* ignore */
        }
        logLlmDebug(
          provider,
          request.requestId,
          'http_error',
          `HTTP ${response.status} (model=${model}): ${body}`,
        );
      } else {
        // Drain the body so the socket is freed, but keep none of it.
        await drain(response);
      }
      throw new LlmError('http_error', provider, request.requestId, {
        httpStatus: response.status,
      });
    }

    const raw = await response.text();
    const extracted = extractStructured(provider, raw, request.requestId, model);
    const value = unwrapEnvelope(extracted.value, providerSchema.wrapped);

    const validation = request.schema.safeParse(value);
    if (!validation.success) {
      // Suppress the ZodError: it details the provider's raw payload and must
      // not escape via Error.cause (§5.3). The kind + requestId are enough.
      throw new LlmError('schema_validation_failed', provider, request.requestId);
    }

    const result: import('./types.js').LlmResponse<T> = {
      output: validation.data,
      model: {
        provider,
        model: extracted.providerModel,
        requestId: request.requestId,
      },
    };
    return extracted.usage ? { ...result, usage: extracted.usage } : result;
  } catch (err) {
    if (err instanceof LlmError) throw err;
    // Unexpected failure — wrap as a provider_error without attaching the
    // raw error as cause (§5.3: logs/inspect must not leak provider internals).
    // Opt-in debug logging records the cause (e.g. a JSON parse error when the
    // model didn't return valid structured output) so it can be investigated.
    logLlmDebug(
      provider,
      request.requestId,
      'provider_error',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    throw new LlmError('provider_error', provider, request.requestId);
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* OpenAI-family response_format: strict only when the schema can honor it   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the `json_schema` member of an OpenAI-family `response_format`.
 *
 * OpenAI Structured Outputs `strict: true` forbids `anyOf`/`oneOf`/`$ref`
 * anywhere in the schema and requires every object's `properties` to be
 * fully listed in `required`. {@link toProviderSchema} now eliminates `oneOf`
 * everywhere (see {@link flattenOneOfBranches}), but the flattened schema
 * only requires each branch's *common* keys (e.g. just `action` for F1) —
 * still strict-incompatible, since most properties stay optional. Forcing
 * `strict: true` on it would 400 the `openai`, `openrouter`, and OpenAI-
 * compatible `custom` providers, so strict is requested only when the schema
 * can actually honor it and omitted otherwise — a valid provider-native
 * structured-output request either way (strict defaults to false).
 *
 * Note what omitting `strict` does NOT buy: the root-must-be-an-object rule is
 * enforced by OpenAI regardless of `strict`, which is why the root-union
 * normalization lives in {@link toProviderSchema} and not here.
 *
 * The authoritative guarantee always comes from the mandatory Zod
 * re-validation after the provider returns (§5.2). No silent fallback is
 * fabricated here: the request reaches the real provider, and any output the
 * provider returns is still bent to the Zod schema before being accepted.
 */
function openAiJsonSchema(schema: unknown): {
  name: string;
  schema: unknown;
  strict?: true;
} {
  const strict = isOpenAiStrictCompatible(schema) ? (true as const) : undefined;
  const envelope: { name: string; schema: unknown; strict?: true } = {
    name: 'teamem_structured_output',
    schema,
  };
  if (strict) envelope.strict = strict;
  return envelope;
}

/**
 * Whether `schema` meets OpenAI Structured Outputs strict-mode constraints:
 * the ROOT must be an object, no `anyOf`/`oneOf`/`allOf`/`$ref` keyword may
 * appear anywhere (including nested objects, array items, and `$defs`), and
 * every object node's `properties` must all be listed in that node's
 * `required` (OpenAI's actual strict-mode rule — optional fields have to be
 * modeled as nullable-but-required, which no schema here does, so this
 * correctly falls back to non-strict rather than mis-certifying a schema
 * like the flattened F1/F2 output — where most keys stay genuinely optional
 * after the `oneOf` merge — as strict-compatible). Primitive node types are
 * allowed at non-root positions.
 */
function isOpenAiStrictCompatible(schema: unknown): boolean {
  if (!isObject(schema) || schema.type !== 'object') return false;
  return strictCompatibleSubtree(schema);
}

function strictCompatibleSubtree(node: unknown): boolean {
  if (!isObject(node)) return true; // primitive values are fine
  if (
    'anyOf' in node || 'oneOf' in node || 'allOf' in node || '$ref' in node
  ) {
    return false;
  }
  const properties = node.properties;
  if (isObject(properties)) {
    const required = Array.isArray(node.required) ? node.required : [];
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) return false;
    }
    for (const value of Object.values(properties)) {
      if (!strictCompatibleSubtree(value)) return false;
    }
  }
  const items = node.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!strictCompatibleSubtree(item)) return false;
    }
  } else if (isObject(items)) {
    if (!strictCompatibleSubtree(items)) return false;
  }
  for (const defKey of ['$defs', 'definitions']) {
    const defs = node[defKey];
    if (isObject(defs)) {
      for (const value of Object.values(defs)) {
        if (!strictCompatibleSubtree(value)) return false;
      }
    }
  }
  return true;
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
): { url: string; init: RequestInit } {
  if (config.kind === 'claude') {
    return buildClaudeRequest(
      config,
      model,
      systemPrompt,
      userPrompt,
      jsonSchema,
      signal,
    );
  }

  // OpenAI / OpenRouter / custom all speak the Chat Completions API.
  const url = endpointFor(config);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  };
  if (config.kind === 'openrouter') {
    headers['X-Title'] = 'teamem';
  }
  return {
    url,
    init: {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: openAiJsonSchema(jsonSchema),
        },
      }),
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Response parsing                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

interface Extracted {
  value: unknown;
  providerModel: string;
  usage?: import('./types.js').LlmUsage;
}

function extractStructured(
  provider: LlmProviderKind,
  raw: string,
  requestId: string,
  fallbackModel: string,
): Extracted {
  if (provider === 'claude') {
    return parseClaudeResponse(raw, requestId, fallbackModel);
  }
  return parseOpenAiFamily(provider, raw, requestId, fallbackModel);
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
    logLlmDebug(provider, requestId, 'provider_error', `response body was not valid JSON: ${raw}`);
    throw new LlmError('provider_error', provider, requestId);
  }
  if (!isObject(envelope)) {
    logLlmDebug(provider, requestId, 'provider_error', `response was not a JSON object: ${raw}`);
    throw new LlmError('provider_error', provider, requestId);
  }
  const providerModel =
    typeof envelope.model === 'string' ? envelope.model : fallbackModel;
  const usage = parseOpenAiUsage(envelope.usage);
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
    logLlmDebug(
      provider,
      requestId,
      'schema_validation_failed',
      `model content was not valid JSON: ${content}`,
    );
    throw new LlmError('schema_validation_failed', provider, requestId);
  }
  return usage ? { value, providerModel, usage } : { value, providerModel };
}

/**
 * Normalize the OpenAI-family `usage` envelope into
 * {@link import('./types.js').LlmUsage}.
 *
 * `total_tokens` is used when present and derived otherwise, since
 * OpenAI-compatible endpoints do not all send it. An unparseable or absent
 * envelope yields `undefined` — "not reported" must not be recorded as zero.
 */
function parseOpenAiUsage(raw: unknown): import('./types.js').LlmUsage | undefined {
  if (!isObject(raw)) return undefined;
  const promptTokens = raw['prompt_tokens'];
  const completionTokens = raw['completion_tokens'];
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') {
    return undefined;
  }
  const total = raw['total_tokens'];
  return {
    promptTokens,
    completionTokens,
    totalTokens: typeof total === 'number' ? total : promptTokens + completionTokens,
  };
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

/**
 * Property name used when a schema has to be wrapped in a root envelope.
 * Exported so tests can assert the wire shape without duplicating the literal.
 */
export const SCHEMA_ENVELOPE_PROPERTY = 'result';

interface ProviderSchema {
  /** JSON Schema in a shape every supported provider accepts at the root. */
  readonly schema: unknown;
  /** True when the caller's schema was wrapped in {@link SCHEMA_ENVELOPE_PROPERTY}. */
  readonly wrapped: boolean;
}

/**
 * Normalize a Zod-derived JSON Schema into the only root shape the providers
 * accept, and report whether wrapping happened so the response can be unwrapped.
 *
 * Both provider families require the root of a structured-output schema to be
 * a plain object, and both reject a root combinator. Verified against the live
 * APIs with the real F1 schema (a `z.discriminatedUnion`, which `z.toJSONSchema`
 * renders as a bare root `oneOf` with no `type`):
 *
 *   - Anthropic, `{ oneOf: [...] }`            → 400 `input_schema.type: Field required`
 *   - Anthropic, `{ type: 'object', oneOf }`   → 400 `input_schema does not support
 *                                                 oneOf, allOf, or anyOf at the top level`
 *   - OpenAI,    `{ oneOf: [...] }`            → 400 `schema must be a JSON Schema of
 *                                                 'type: "object"', got 'type: "None"'`
 *
 * The OpenAI rejection happens with `strict` absent, so omitting `strict` is
 * NOT sufficient for a root union — an earlier revision assumed it was, which
 * is why every real F1/F2 call failed on every provider.
 *
 * An earlier revision of this function wrapped the union in a root envelope
 * but left `oneOf` nested one level down inside it, on the assumption that
 * nested combinators are accepted everywhere. That held for direct Anthropic
 * tool-use and direct OpenAI calls, but not for every path a provider config
 * can reach: OpenRouter's OpenAI-compatible `response_format`, when routed to
 * an Anthropic-family backend (Bedrock/Azure/Anthropic all observed), gets
 * translated into Anthropic's native structured-output request and rejects
 * `oneOf` anywhere in the schema — `output_config.format.schema: Schema type
 * 'oneOf' is not supported` — not just at the root. So `oneOf` is now
 * eliminated everywhere via {@link flattenOneOfBranches}, not merely moved:
 * every branch's properties are merged into one permissive object, which is
 * necessarily less strict than the original union at the JSON-Schema level.
 * That's an accepted trade-off, not a weakening of the real contract — the
 * Zod discriminated union re-validates every response after the fact (§5.2),
 * so a model that exploits the widened schema still fails validation; this
 * schema only has to steer the model, not gate correctness.
 */
function toProviderSchema(schema: unknown): ProviderSchema {
  const stripped = flattenOneOfBranches(stripSchemaAnchor(schema));
  if (isObject(stripped) && stripped.type === 'object' && !hasRootCombinator(stripped)) {
    return { schema: stripped, wrapped: false };
  }
  return {
    schema: {
      type: 'object',
      description:
        'Envelope for the requested structured output. Put the result object ' +
        'in the "result" property.',
      properties: {
        [SCHEMA_ENVELOPE_PROPERTY]: stripped,
      },
      required: [SCHEMA_ENVELOPE_PROPERTY],
      additionalProperties: false,
    },
    wrapped: true,
  };
}

function hasRootCombinator(node: Record<string, unknown>): boolean {
  return 'oneOf' in node || 'anyOf' in node || 'allOf' in node;
}

/**
 * Recursively flatten every `oneOf` of object-schema branches into a single
 * merged object schema: `properties` is the union of every branch's
 * properties, and `required` is the intersection (only keys required in
 * every branch — for a discriminated union that's exactly the discriminant).
 *
 * A property key present in more than one branch is merged by
 * {@link mergePropertyVariants} rather than overwritten, so a discriminant
 * like `action: { const: 'extract' }` vs `action: { const: 'skip' }` becomes
 * `action: { enum: ['extract', 'skip'] }` instead of silently losing one
 * branch's value.
 *
 * `oneOf` nodes that aren't a plain list of object-type branches (e.g. a
 * union of primitives) are left untouched — this only targets the shape
 * `z.discriminatedUnion`/`z.union` of `z.object` produces, which is the only
 * pattern any current F1/F2 schema uses.
 */
function flattenOneOfBranches(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(flattenOneOfBranches);
  }
  if (!isObject(node)) return node;

  const recursed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    recursed[key] = flattenOneOfBranches(value);
  }

  const branches = recursed['oneOf'];
  if (
    !Array.isArray(branches) ||
    branches.length === 0 ||
    !branches.every(isFlattenableBranch)
  ) {
    return recursed;
  }

  const properties: Record<string, unknown> = {};
  const variantsByKey = new Map<string, unknown[]>();
  for (const branch of branches) {
    for (const [key, valueSchema] of Object.entries(branch.properties)) {
      const variants = variantsByKey.get(key) ?? [];
      variants.push(valueSchema);
      variantsByKey.set(key, variants);
    }
  }
  for (const [key, variants] of variantsByKey) {
    properties[key] = mergePropertyVariants(variants);
  }

  let required: string[] | null = null;
  for (const branch of branches) {
    const branchRequired = Array.isArray(branch.required)
      ? (branch.required as string[])
      : [];
    required =
      required === null
        ? branchRequired
        : required.filter((k) => branchRequired.includes(k));
  }

  const { oneOf: _oneOf, ...rest } = recursed;
  void _oneOf;
  return {
    ...rest,
    type: 'object',
    properties,
    required: required ?? [],
    additionalProperties: false,
  };
}

function isFlattenableBranch(
  branch: unknown,
): branch is { type: 'object'; properties: Record<string, unknown>; required?: unknown } {
  return (
    isObject(branch) &&
    branch.type === 'object' &&
    isObject(branch.properties)
  );
}

/**
 * Merge the schemas a property was given across different `oneOf` branches
 * into one. Identical schemas collapse to one copy. Schemas that differ only
 * by a `const` (the shape a discriminated union's literal tag produces —
 * `{ type: 'string', const: 'extract' }` vs `{ type: 'string', const: 'skip' }`)
 * merge into a single `enum` of the distinct literal values, which is a plain
 * constraint keyword, not a combinator, so it's unaffected by the `oneOf`
 * rejection this function exists to work around.
 *
 * Anything else (genuinely different types/shapes for the same key across
 * branches) falls back to an unconstrained `{}` — no current F1/F2 schema
 * produces this, and an unconstrained hint is still safe because the real
 * enforcement is the post-response Zod validation, not this schema.
 */
function mergePropertyVariants(variants: unknown[]): unknown {
  const first = variants[0];
  if (variants.every((v) => JSON.stringify(v) === JSON.stringify(first))) {
    return first;
  }

  const literals: unknown[] = [];
  let allConstLiterals = true;
  for (const variant of variants) {
    if (
      isObject(variant) &&
      Object.keys(variant).length === 2 &&
      typeof variant.type === 'string' &&
      'const' in variant
    ) {
      literals.push(variant.const);
    } else {
      allConstLiterals = false;
      break;
    }
  }
  if (allConstLiterals) {
    return { type: (first as Record<string, unknown>).type, enum: literals };
  }

  return {};
}

/**
 * Undo {@link toProviderSchema}'s envelope before Zod re-validation.
 *
 * A non-object payload, or a missing envelope property, is passed through
 * unchanged so the Zod re-validation below reports it as
 * `schema_validation_failed` rather than this helper inventing a diagnosis.
 *
 * The string branch is not a text-parsing fallback (§5.2): Anthropic has been
 * observed filling an envelope property whose schema is a union with the
 * serialized JSON object rather than the object itself. That value is still
 * the provider's own structured field, and the Zod schema remains the sole
 * authority on whether the result is acceptable — a string that does not parse
 * is handed on untouched and fails validation.
 */
function unwrapEnvelope(value: unknown, wrapped: boolean): unknown {
  if (!wrapped || !isObject(value)) return value;
  const inner = value[SCHEMA_ENVELOPE_PROPERTY];
  if (typeof inner === 'string') {
    try {
      return JSON.parse(inner);
    } catch {
      return inner;
    }
  }
  return inner;
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