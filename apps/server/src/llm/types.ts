/**
 * Provider-neutral LLM structured-output port (AGPL-3.0-only, M0-F1-02).
 *
 * This module defines the single boundary the F1/F2 compiler uses to call an
 * LLM and get back validated, structured output. It is deliberately
 * provider-neutral: the compiler never knows whether the runtime is wired to
 * Claude, OpenAI, OpenRouter, or a custom OpenAI-compatible endpoint. It only
 * hands over a Zod schema, two prompt messages, a timeout, and a request id,
 * and receives either a schema-validated object plus model metadata or a
 * redacted {@link LlmError}.
 *
 * Why a "port" rather than a concrete client: the project's red line (§5.2)
 * is that F1/F2 must use provider-native structured output (forced tool use /
 * JSON Schema response formats) and that output must pass the `@teamem/schema`
 * Zod schema before persistence. Both halves are enforced here — the factory
 * (factory.ts) wires the provider-native mechanism, and this port makes the
 * Zod re-validation and the redacted error surface the same regardless of
 * provider.
 *
 * Error hygiene (§5.3, §6.4): an {@link LlmError} stores a stable `kind`, the
 * provider name, the request id, and at most an HTTP status. It must never
 * carry an API key, a request body, a model payload, or a raw provider
 * message, because these surfaces (logs, audits, job snapshots, results) must
 * not leak the original content. Provider error bodies are read solely to be
 * classified; nothing from them is retained.
 */
import type { z } from 'zod';

/** The four BYO provider kinds the self-hosted build actually supports. */
export type LlmProviderKind = 'claude' | 'openai' | 'openrouter' | 'custom';

/**
 * Output token ceiling sent on every structured-output request, for every
 * provider family. Sized against the largest field either F1 or F2 output
 * can legally produce — F2's `mergedBody` alone is capped at 50,000
 * characters (compiler/f2/decision.ts), and F1's `body` (compiler/f1/output.ts)
 * has no cap at all. At a conservative ~3.5 characters/token for
 * markdown-with-escaping output, even the previous 8,192-token cap covered
 * only ~28,700 characters — short of the F2 ceiling alone, before accounting
 * for an unbounded F1 body. 16,000 keeps every provider's request comfortably
 * under GPT-4o's 16,384-token hard ceiling (the tightest mainstream limit)
 * while covering F2's documented worst case with room to spare.
 *
 * This is a mitigation, not a guarantee — a BYO custom/local model can still
 * have a lower ceiling, and F1's body is genuinely unbounded. That's why
 * truncation is also detected directly from the provider's own signal
 * (Claude `stop_reason: "max_tokens"`, OpenAI family `finish_reason:
 * "length"`) and reported as the distinct `output_truncated` error kind
 * rather than left to masquerade as `schema_validation_failed` — see
 * {@link LlmErrorKind}.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Provider-neutral description of the model that produced a response.
 *
 * `model` is the provider-reported model identifier (e.g. `gpt-4o-2024-08-06`
 * or `claude-sonnet-4-5-20250929`). `provider` is the configured kind, and
 * `requestId` is the caller-provided id echoed back so a compile job can
 * trace its single LLM call end to end.
 */
export interface ModelMetadata {
  provider: LlmProviderKind;
  model: string;
  requestId: string;
}

/**
 * A single structured-output request to the LLM.
 *
 * @typeParam T - the TypeScript type the caller will receive on success.
 *
 * `schema` is the Zod schema the response is re-validated against after the
 * provider returns (§5.2: never trust a JSON string implicitly). `timeoutMs`
 * overrides the provider default; when omitted the factory-built client uses
 * a sane default. `requestId` is mandatory and is the only identifier that
 * crosses the boundary — it is used for tracing and is surfaced in errors.
 */
export interface LlmRequest<T> {
  schema: z.ZodType<T>;
  systemPrompt: string;
  userPrompt: string;
  /** Per-request timeout, milliseconds. Overrides the provider default. */
  timeoutMs?: number;
  /** Caller-provided request id; mandatory so every error is traceable. */
  requestId: string;
}

/**
 * Token counts reported by the provider for a single call.
 *
 * Every supported provider returns these in its response envelope (Anthropic
 * as `usage.input_tokens`/`output_tokens`, the OpenAI family as
 * `usage.prompt_tokens`/`completion_tokens`/`total_tokens`); the adapters
 * normalize them into this one shape so cost reporting does not branch on
 * provider. It is optional on {@link LlmResponse} because a provider may omit
 * the envelope — an absent `usage` means "not reported", never zero.
 */
export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** A successfully completed structured-output call. */
export interface LlmResponse<T> {
  /** The provider output after Zod re-validation against `schema`. */
  output: T;
  /** Provenance of the response: which provider/model produced it. */
  model: ModelMetadata;
  /** Provider-reported token counts, when the response envelope carried them. */
  usage?: LlmUsage;
}

/**
 * The port. The compiler depends on this interface, not on any concrete
 * adapter, so swapping providers is a composition-root wiring change.
 */
export interface LlmClient {
  structured<T>(request: LlmRequest<T>): Promise<LlmResponse<T>>;
}

/**
 * Injectable `fetch`-compatible transport. The factory defaults to the global
 * `fetch`; tests inject a fake so the real request construction, abort/timeout
 * wiring, response parsing, and Zod re-validation run without network or keys.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Optional overrides the factory accepts. Everything is optional: in a real
 * deployment the global `fetch`, the documented {@link DEFAULT_MODELS}, and
 * the default timeout suffice; tests and the composition root may override.
 */
export interface LlmClientDeps {
  /** Override the provider default model (real model id). */
  defaultModel?: string;
  /** Default per-request timeout in ms when the request omits `timeoutMs`. */
  defaultTimeoutMs?: number;
  /** Transport; defaults to `globalThis.fetch`. Mock only in unit tests. */
  fetch?: FetchLike;
}

/**
 * Stable, redacted error kinds. These are the only failure surfaces the
 * compiler sees; they map to compile-job failure reasons rather than leaking
 * provider specifics.
 *
 * - `config_rejected` — the provider config is unusable in this build
 *   (e.g. `platform-managed` in the self-hosted build). Raised synchronously
 *   by the factory before any network I/O.
 * - `timeout` — `timeoutMs` elapsed before the provider responded.
 * - `aborted` — the call was aborted for another reason (signal/shutdown).
 * - `http_error` — the provider returned a non-2xx status.
 * - `provider_error` — a 2xx response that the provider marked as an error,
 *   or that did not contain an expected structured payload.
 * - `empty_output` — the provider returned no parseable content.
 * - `output_truncated` — the provider's own signal (Claude `stop_reason:
 *   "max_tokens"`, OpenAI family `finish_reason: "length"`) says it stopped
 *   generating because it hit {@link MAX_OUTPUT_TOKENS}, and the resulting
 *   output failed to parse/validate as a result. Distinct from
 *   `schema_validation_failed` so a length problem doesn't masquerade as a
 *   model correctness problem — the two need different fixes (a bigger
 *   output budget vs. a genuinely wrong extraction).
 * - `schema_validation_failed` — output was received in full but failed the
 *   Zod schema; §5.2 treats this as an explicit compilation failure.
 */
export type LlmErrorKind =
  | 'config_rejected'
  | 'timeout'
  | 'aborted'
  | 'http_error'
  | 'provider_error'
  | 'empty_output'
  | 'output_truncated'
  | 'schema_validation_failed';

/**
 * The only error type the LLM port throws. Redacted by construction: the
 * `message` is a fixed, kind-specific string and the stored fields are limited
 * to the provider name, the request id, and at most an HTTP status. No API
 * key, request body, model payload, or raw provider error text is ever kept,
 * and no `cause` is attached — `Error.cause` would surface raw fetch/Zod/
 * provider internals to logs and inspect (§5.3/§6.4), so it is intentionally
 * not retained. Callers that need debugging detail should probe the provider
 * themselves; the port keeps the failure surface redacted.
 *
 * This keeps logs, audits, and job snapshots (§5.3) free of original content
 * and secrets even when a call fails.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: LlmProviderKind;
  readonly requestId: string;
  readonly httpStatus?: number;

  constructor(
    kind: LlmErrorKind,
    provider: LlmProviderKind,
    requestId: string,
    options: { httpStatus?: number } = {},
  ) {
    super(redactedMessage(kind, provider, options.httpStatus));
    this.name = 'LlmError';
    this.kind = kind;
    this.provider = provider;
    this.requestId = requestId;
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
  }
}

function redactedMessage(kind: LlmErrorKind, provider: LlmProviderKind, httpStatus?: number): string {
  const prefix = `LLM ${kind} from ${provider}`;
  if (kind === 'http_error' && httpStatus !== undefined) {
    return `${prefix} (status ${httpStatus}); request body and provider error text redacted`;
  }
  if (kind === 'schema_validation_failed') {
    return `${prefix}: provider output did not satisfy the requested Zod schema`;
  }
  if (kind === 'output_truncated') {
    return `${prefix}: provider stopped generating after hitting the output token limit`;
  }
  if (kind === 'config_rejected') {
    return `${prefix}: provider configuration is not usable in this build`;
  }
  return `${prefix}`;
}