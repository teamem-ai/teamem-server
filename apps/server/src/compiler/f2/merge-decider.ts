/**
 * F2 merge-decider — strong-model adapter for merge decisions (M1-F2-03).
 *
 * Takes a new F1-extracted concept, a shortlist of existing candidate concepts,
 * and an {@link LlmClient}, and asks a strong model to produce a structured
 * merge decision: confirms, extends, contradicts, or unrelated (new concept).
 *
 * The LLM call uses provider-native structured output with the F2-01 JSON
 * Schema ({@link f2Decision} from decision.ts). The LLM client performs
 * mandatory Zod re-validation after the provider returns (§5.2: never trust
 * an implicit JSON string; schema validation failure is an explicit
 * compilation failure). This function additionally re-validates the Zod output
 * (double-check) and enforces the contradicts→disputed red line before
 * returning.
 *
 * Injected dependency: an {@link LlmClient} so the transport boundary is
 * swappable for unit tests with a fake fetch. No direct HTTP, no real keys,
 * no provider-specific branching here — this module only depends on the
 * provider-neutral port.
 */

import type { LlmClient } from '../../llm/types.js';
import { f2Decision, type F2Decision } from './decision.js';
import { buildF2MergePrompt, type F2MergePromptContext } from './merge-prompt.js';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * A lightweight summary of an existing candidate concept for merge-decision
 * input. This is NOT the full database row — it contains only the semantic
 * fields the model needs to judge relatedness and write a merged body.
 */
export interface CandidateConceptSummary {
  /** Canonical UUID — the immutable identity. */
  readonly uuid: string;
  /** Current concept type. */
  readonly type: string;
  /** Current concept status. */
  readonly status: string;
  /** Current title. */
  readonly title: string;
  /** Current markdown body. */
  readonly body: string;
  /** Current path (readable locator). */
  readonly path: string;
  /** Current tags. */
  readonly tags: string[];
  /** Short evidence summaries: kind + reference for each evidence item. */
  readonly evidenceSummary: string[];
}

/**
 * The new concept as output by F1 — semantic content plus source-event
 * context (so the model knows where this claim came from).
 */
export interface NewConceptInput {
  /** F1-extracted concept type. */
  readonly type: string;
  /** F1-extracted title. */
  readonly title: string;
  /** F1-extracted markdown body. */
  readonly body: string;
  /** F1-extracted path. */
  readonly path: string;
  /** F1-extracted tags. */
  readonly tags: string[];
  /** F1-extracted confidence. */
  readonly confidence: string;
  /** Source channel (github, cli, mcp, external). */
  readonly channel: string;
  /** Source event kind (github_commit, cli_init, etc.). */
  readonly kind: string;
  /** Human-readable external reference. */
  readonly externalId: string;
}

/**
 * Injectable dependencies for {@link decideMerge}.
 *
 * Only `llm` is required — the merge-decider has no database or config
 * dependency of its own. Everything else is pure computation.
 */
export interface MergeDeciderDeps {
  readonly llm: LlmClient;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Ask a strong model to decide how a new concept relates to existing
 * candidates.
 *
 * Builds the F2 merge prompt, calls the LLM with structured output forced to
 * the {@link f2Decision} schema, and returns the validated decision. The LLM
 * client performs first-pass Zod re-validation; this function adds a
 * second-pass Zod parse (defense in depth) before returning.
 *
 * Validation failure from the LLM client (provider returned non-conforming
 * JSON) propagates as an {@link import('../../llm/types.js').LlmError} with
 * kind `schema_validation_failed`. The caller must treat this as a
 * compilation failure — retry or route to human review, never loosely accept.
 *
 * @param deps    - injectable dependencies (at minimum, an {@link LlmClient}).
 * @param newConcept - the F1-extracted concept to merge.
 * @param candidates - existing concepts that might be related (may be empty).
 * @param requestId   - caller-provided id for tracing (compile job id + event id).
 * @returns A validated {@link F2Decision} — the model's judgment.
 * @throws {@link import('../../llm/types.js').LlmError} on provider or schema failure.
 */
export async function decideMerge(
  deps: MergeDeciderDeps,
  newConcept: NewConceptInput,
  candidates: CandidateConceptSummary[],
  requestId: string,
): Promise<F2Decision> {
  const { llm } = deps;

  // 1. Build the F2 merge prompt.
  const ctx: F2MergePromptContext = { newConcept, candidates };
  const { system, user } = buildF2MergePrompt(ctx);

  // 2. Call the LLM with provider-native structured output.
  //    The LlmClient re-validates (first pass) against f2Decision internally.
  //    Schema validation failure throws LlmError(kind='schema_validation_failed'),
  //    which the caller treats as an explicit compilation failure (§5.2).
  const response = await llm.structured({
    schema: f2Decision,
    systemPrompt: system,
    userPrompt: user,
    requestId,
  });

  // 3. Second-pass Zod validation (defense in depth).
  //    parse() throws ZodError on failure; f2Decision.parse already ran inside
  //    the LlmClient, so this should never fail, but we re-validate to be
  //    explicit about the boundary. The ZodError carries detailed failure
  //    information about the provider's output shape — we do NOT attach it
  //    as an Error cause (§5.3: never leak model payloads to logs).
  const decision = f2Decision.parse(response.output);

  // 4. Return the validated decision.
  return decision;
}
