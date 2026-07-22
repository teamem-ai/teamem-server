/**
 * M1-F1-04 — F1 Signal-to-Noise Metric Script.
 *
 * Runs a batch of events through the F1 pipeline (deterministic prefilter +
 * LLM structured extraction) and produces a machine-readable report measuring:
 *
 *   - Signal-to-noise ratio: extracts vs skips (prefilter + LLM)
 *   - Type distribution among extracts (decision, gotcha, runbook,
 *     convention, service, concept)
 *   - Confidence distribution (high, medium, low)
 *   - Zod schema validation failures (COUNTED AS FAILURES — never silently
 *     downgraded to skip)
 *   - Provider failures (LLM errors not attributable to the schema)
 *   - Per-event latency (ms)
 *
 * This module exports the core logic; the vitest test at
 * `src/compiler/f1/signal-to-noise.f1.test.ts` runs it. The CLI acceptance
 * command is:
 *
 *   pnpm --filter @teamem/server m1:f1-signal
 *
 * Environment variables:
 *   TEAMEM_OPENAI_API_KEY           — enables the 'openai' provider
 *   TEAMEM_ANTHROPIC_API_KEY        — enables the 'claude' provider
 *   TEAMEM_OPENROUTER_API_KEY       — enables the 'openrouter' provider
 *   TEAMEM_OPENAI_COMPAT_BASE_URL + TEAMEM_OPENAI_COMPAT_API_KEY — 'custom'
 *
 * The check skips honestly (outputs `{"status":"skipped","reason":"..."}`)
 * when no LLM provider is configured. It NEVER fabricates numbers.
 */
import { readFileSync } from 'node:fs';
import {
  f1Output,
  type F1Output,
  type F1ExtractOutput,
} from '../src/compiler/f1/output.js';
import {
  buildF1Prompt,
  type F1PromptContext,
} from '../src/compiler/f1/prompt.js';
import {
  prefilterNoise,
} from '../src/compiler/f1/skip-filter.js';
import {
  createLlmClient,
  LlmError,
  DEFAULT_MODELS,
  type LlmClient,
} from '../src/llm/factory.js';
import type { LlmResponse } from '../src/llm/types.js';
import { resolveLlmConfig } from '../src/config/llm.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Per-event outcome after the full F1 pipeline. */
export type F1Outcome =
  | { kind: 'prefilter_skip'; reason: string; latencyMs: number }
  | { kind: 'llm_skip'; reason: string; latencyMs: number }
  | { kind: 'extract'; output: F1ExtractOutput; latencyMs: number }
  | { kind: 'schema_failure'; latencyMs: number; errorCode: string; errorMessage: string }
  | { kind: 'provider_failure'; latencyMs: number; errorCode: string; errorMessage: string };

export interface EventDetail {
  index: number;
  label: string;
  channel: string;
  kind: string;
  outcome: F1Outcome['kind'];
  latencyMs: number;
  outputSummary: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface TypeDistribution {
  decision: number;
  gotcha: number;
  runbook: number;
  convention: number;
  service: number;
  concept: number;
}

export interface ConfidenceDistribution {
  high: number;
  medium: number;
  low: number;
}

export interface SignalReport {
  status: 'ok';
  timestamp: string;
  provider?: string;
  model?: string;
  totalEvents: number;
  summary: {
    /** Events that passed the prefilter AND produced an extract. */
    extract: number;
    /** Events skipped by the deterministic prefilter (no LLM call). */
    prefilterSkip: number;
    /** Events skipped by the LLM (passed prefilter but model chose skip). */
    llmSkip: number;
    /** Total skips (prefilter + LLM). */
    totalSkip: number;
    /** Zod schema validation failures (COUNTED AS FAILURES). */
    schemaFailure: number;
    /** Provider failures (LLM errors: timeout, http_error, etc.). */
    providerFailure: number;
    /** Signal-to-noise ratio: extract / (extract + totalSkip). */
    signalRatio: number;
  };
  typeDistribution: TypeDistribution;
  confidenceDistribution: ConfidenceDistribution;
  latencyMs: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
  };
  details: EventDetail[];
  invariants: {
    /** Schema failures have error info in details and no fabricated output. */
    schemaFailuresNotDowngraded: boolean;
    /** Extract details carry valid outputSummary with required fields. */
    extractsHaveValidOutput: boolean;
    /** Per-kind counts in details match the summary totals. */
    detailCountsMatchSummary: boolean;
    /** Every input fixture produced exactly one outcome. */
    allEventsProcessed: boolean;
  };
}

export interface SkippedReport {
  status: 'skipped';
  reason: string;
  timestamp: string;
}

// ── Embedded fixtures (for when no input file is provided) ──────────────────

/**
 * A set of diverse events designed to exercise the F1 pipeline and produce
 * measurable signal-to-noise metrics. Mix includes:
 *  - Events with clear extractable knowledge (signal)
 *  - Events that are noise (skip by prefilter or LLM)
 *  - Edge cases that test boundaries
 */
export const EMBEDDED_FIXTURES: (F1PromptContext & { label: string })[] = [
  // ── Signal (extractable knowledge) ─────────────────────────────────────
  {
    label: 'PR: architecture decision with rationale',
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#1',
    payload: {
      title: 'feat(db): migrate from MongoDB to Postgres for core event store',
      body: `## Summary
We are migrating the core event store from MongoDB to Postgres.

## Rationale
- Strong ACID guarantees needed for event idempotency
- JSONB provides flexible schema support comparable to MongoDB documents
- Single datastore reduces operational complexity
- pgvector will enable future semantic search on concept pages

## Trade-offs
- We lose horizontal write scaling that MongoDB offered
- Migration requires dual-write period of ~2 weeks`,
    },
  },
  {
    label: 'Issue: production incident with gotcha',
    channel: 'github',
    kind: 'github_issue',
    externalId: 'teamem-ai/teamem#2',
    payload: {
      title: 'PROD: payment webhook timeout causing double charges',
      body: `## Impact
Payment webhook from Stripe times out after 30s, but Stripe retries after 60s.
This means some customers are being charged twice.

## Root Cause
The payment processor makes a synchronous HTTP call to fraud detection,
which occasionally takes 40s during peak hours.

## Gotcha Discovered
Stripe retries webhooks for up to 3 days. If your webhook handler is not
idempotent, the retry will cause duplicate charges. Always use idempotency
keys and verify the Stripe event ID before processing.`,
    },
  },
  {
    label: 'Commit: ADR documenting decision',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@abc0001',
    payload: {
      message: `docs(adr): add ADR-003 — use event sourcing for audit log

## Decision
We will use event sourcing for the audit log instead of a traditional
append-only table because it gives us a replayable log and makes temporal
queries trivial.

## Alternatives Considered
- CDC: rejected because it couples audit to current schema
- Append-only table: rejected because of complex temporal queries`,
      sha: 'abc0001def',
    },
  },
  {
    label: 'PR review: design pattern convention',
    channel: 'github',
    kind: 'github_pr_comment',
    externalId: 'teamem-ai/teamem#1',
    payload: {
      body: `We should use the Strategy pattern instead of a switch statement here.

The current implementation has a switch on paymentProvider with 5 cases, and
we're about to add 3 more. A Strategy pattern would make each provider's
logic independently testable and allow adding new providers without modifying
existing code. This has worked well in the notification service.`,
      path: 'src/payments/processor.ts',
      line: 142,
    },
  },
  {
    label: 'CLI init: service runbook documentation',
    channel: 'cli',
    kind: 'cli_init',
    externalId: 'teamem-ai/teamem:docs/runbooks/rotate-credentials.md',
    payload: {
      repo: 'teamem-ai/teamem',
      commitSha: 'def0001abc',
      path: 'docs/runbooks/rotate-credentials.md',
      content: `# How to Rotate Database Credentials

## When to Use
- Credential has been exposed or is suspected of being exposed
- Quarterly rotation as part of security hygiene

## Steps
1. Generate new credentials in the secret manager
2. Update the DATABASE_URL environment variable
3. Run the credential update script: ./scripts/rotate-db-credentials.sh
4. Verify the app starts and responds to health checks
5. Revoke old credentials after 1 hour of stable operation`,
      schemaVersion: 1,
    },
  },
  {
    label: 'Issue: coding convention proposal',
    channel: 'github',
    kind: 'github_issue',
    externalId: 'teamem-ai/teamem#3',
    payload: {
      title: 'Proposal: require Zod validation for all API boundaries',
      body: `## Proposal
Every HTTP handler, queue consumer, and MCP tool MUST validate its input
with a Zod schema before processing.

## Motivation
We've had 3 production incidents in Q1 from missing validation:
1. Missing field caused null pointer in payment processor
2. Malformed date string crashed the report generator
3. User-injected extra fields bypassed the allowlist

## Proposed Convention
- Define Zod schemas in the same file as the handler
- Use .strict() by default — reject unknown fields
- Error responses must use the teamem error envelope`,
      labels: ['convention', 'discussion'],
    },
  },
  {
    label: 'PR: deployment gotcha discovered',
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#4',
    payload: {
      title: 'fix(deploy): add init container for migrations',
      body: `## Problem
Deployments were failing because the app started before migrations completed.
Docker Compose depends_on with condition: service_healthy only waits for the
container health check, NOT for application-level readiness.

## Gotcha
Never rely on container health checks for application readiness. Always
verify with a dedicated readiness endpoint or use an init container that
runs migrations before the app starts.`,
    },
  },
  {
    label: 'Commit: service architecture overview',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@abc0002',
    payload: {
      message: `docs: document the payment service architecture

The Payment Worker processes events from the payment queue and reconciles
with Stripe. It exposes health checks at :9090/health and metrics at
:9090/metrics. The worker is configured via PAYMENT_QUEUE_URL and
STRIPE_API_KEY environment variables.`,
      sha: 'abc0002def',
    },
  },

  // ── Noise (should be skipped) ──────────────────────────────────────────
  {
    label: 'Commit: typo fix — prefilter skip',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@noise001',
    payload: {
      message: 'fix typo',
      sha: 'noise001abc',
    },
  },
  {
    label: 'Commit: whitespace-only — prefilter skip',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@noise002',
    payload: {
      message: '  ',
      sha: 'noise002abc',
    },
  },
  {
    label: 'Commit: meaningless "asdf" — prefilter skip',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@noise003',
    payload: {
      message: 'asdf',
      sha: 'noise003abc',
    },
  },
  {
    label: 'Commit: Dependabot bump — prefilter skip',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@noise004',
    payload: {
      message: `Bump eslint from 8.57.0 to 8.57.1

---
updated-dependencies:
- dependency-name: eslint
  dependency-type: direct:development
...

Signed-off-by: dependabot[bot] <support@github.com>`,
      sha: 'noise004abc',
    },
  },
  {
    label: 'Commit: merge commit — prefilter skip',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@noise005',
    payload: {
      message: "Merge branch 'feature/new-auth' into main",
      sha: 'noise005abc',
    },
  },
  {
    label: 'Commit: version-only tag — prefilter skip',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@noise006',
    payload: {
      message: 'v1.2.3',
      sha: 'noise006abc',
    },
  },
  {
    label: 'PR comment: "LGTM" — prefilter skip',
    channel: 'github',
    kind: 'github_pr_comment',
    externalId: 'teamem-ai/teamem#4',
    payload: {
      body: 'LGTM',
      path: 'src/app.ts',
      line: 10,
    },
  },
  {
    label: 'PR: mechanical config change — LLM should skip',
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#5',
    payload: {
      title: 'chore: update eslint config',
      body: 'Updated the eslint config to use the new flat config format.',
    },
  },

  // ── Edge cases / ambiguous ─────────────────────────────────────────────
  {
    label: 'Issue: question with no body — borderline',
    channel: 'github',
    kind: 'github_issue',
    externalId: 'teamem-ai/teamem#6',
    payload: {
      title: 'How do I set up the dev environment?',
      body: '',
    },
  },
  {
    label: 'Commit: short vague message — prefilter skip or LLM skip',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@edge001',
    payload: {
      message: 'update README',
      sha: 'edge001abc',
    },
  },
  {
    label: 'Commit: single emoji — prefilter skip',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@edge002',
    payload: {
      message: '🚀',
      sha: 'edge002abc',
    },
  },
  {
    label: 'CLI init: empty content — prefilter skip',
    channel: 'cli',
    kind: 'cli_init',
    externalId: 'teamem-ai/teamem:docs/empty.md',
    payload: {
      repo: 'teamem-ai/teamem',
      commitSha: 'empty00001',
      path: 'docs/empty.md',
      content: '',
      schemaVersion: 1,
    },
  },
];

// ── LLM Provider Resolution ─────────────────────────────────────────────────

export interface ResolvedProvider {
  client: LlmClient;
  kind: string;
  model: string;
}

/**
 * Try to resolve a BYO LLM provider from environment variables.
 * Returns null when no provider is configured — the caller must skip honestly.
 */
export function resolveProvider(): ResolvedProvider | null {
  const env = process.env;

  if (env['TEAMEM_OPENAI_API_KEY']) {
    const config = resolveLlmConfig({
      kind: 'openai',
      apiKey: env['TEAMEM_OPENAI_API_KEY'],
    });
    return {
      client: createLlmClient(config),
      kind: 'openai',
      model: DEFAULT_MODELS['openai'],
    };
  }

  if (env['TEAMEM_ANTHROPIC_API_KEY']) {
    const config = resolveLlmConfig({
      kind: 'claude',
      apiKey: env['TEAMEM_ANTHROPIC_API_KEY'],
    });
    return {
      client: createLlmClient(config),
      kind: 'claude',
      model: DEFAULT_MODELS['claude'],
    };
  }

  if (env['TEAMEM_OPENROUTER_API_KEY']) {
    const config = resolveLlmConfig({
      kind: 'openrouter',
      apiKey: env['TEAMEM_OPENROUTER_API_KEY'],
    });
    return {
      client: createLlmClient(config),
      kind: 'openrouter',
      model: DEFAULT_MODELS['openrouter'],
    };
  }

  if (
    env['TEAMEM_OPENAI_COMPAT_BASE_URL'] &&
    env['TEAMEM_OPENAI_COMPAT_API_KEY']
  ) {
    const config = resolveLlmConfig({
      kind: 'custom',
      baseUrl: env['TEAMEM_OPENAI_COMPAT_BASE_URL'],
      apiKey: env['TEAMEM_OPENAI_COMPAT_API_KEY'],
    });
    return {
      client: createLlmClient(config, {
        defaultModel: env['TEAMEM_OPENAI_COMPAT_MODEL'] || undefined,
      }),
      kind: 'custom',
      model: env['TEAMEM_OPENAI_COMPAT_MODEL'] || '(custom endpoint)',
    };
  }

  return null;
}

// ── Event loading ───────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load fixtures from a JSON file or fall back to embedded fixtures.
 */
export function loadFixtures(
  inputPath?: string,
): (F1PromptContext & { label: string })[] {
  if (inputPath) {
    const raw = readFileSync(inputPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Fixture file must be a JSON array');
    }
    return parsed.map((item: unknown, i: number) => {
      if (!isObject(item)) {
        throw new Error(`Fixture item ${i} is not an object`);
      }
      return {
        label: String(item['label'] ?? `fixture-${i}`),
        channel: String(item['channel'] ?? 'cli'),
        kind: String(item['kind'] ?? 'cli_init'),
        externalId: String(item['externalId'] ?? `fixture-${i}`),
        payload: (item['payload'] as Record<string, unknown>) ?? {},
      };
    });
  }

  return EMBEDDED_FIXTURES;
}

// ── Single-Event Execution ──────────────────────────────────────────────────

/**
 * Run a single event through the complete F1 pipeline:
 *  1. Deterministic prefilter (skip-filter.ts)
 *  2. If not prefiltered, LLM structured extraction
 *
 * Returns a typed outcome — every path is explicit; there is no
 * "approximately correct" fallback.
 */
export async function runOneEvent(
  client: LlmClient,
  ctx: F1PromptContext & { label: string },
  requestId: string,
): Promise<F1Outcome> {
  const started = performance.now();

  // ── Step 1: Deterministic prefilter ──────────────────────────────────
  const prefilterResult = prefilterNoise(ctx.channel, ctx.kind, ctx.payload);
  if (prefilterResult) {
    return {
      kind: 'prefilter_skip',
      reason: prefilterResult.reason,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  // ── Step 2: LLM structured extraction ────────────────────────────────
  // The caller guarantees a client is available (checked before the loop).
  const { system, user } = buildF1Prompt(ctx);

  try {
    const response: LlmResponse<F1Output> = await client.structured({
      schema: f1Output,
      systemPrompt: system,
      userPrompt: user,
      requestId,
    });

    const latencyMs = Math.round(performance.now() - started);

    if (response.output.action === 'extract') {
      return {
        kind: 'extract',
        output: response.output,
        latencyMs,
      };
    }
    return {
      kind: 'llm_skip',
      reason: response.output.reason,
      latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - started);

    if (err instanceof LlmError) {
      if (err.kind === 'schema_validation_failed') {
        return {
          kind: 'schema_failure',
          latencyMs,
          errorCode: err.kind,
          errorMessage: err.message,
        };
      }
      return {
        kind: 'provider_failure',
        latencyMs,
        errorCode: err.kind,
        errorMessage: err.message,
      };
    }

    return {
      kind: 'provider_failure',
      latencyMs,
      errorCode: 'unknown_error',
      errorMessage:
        err instanceof Error ? err.message.slice(0, 500) : 'Unknown error',
    };
  }
}

// ── Report Building ─────────────────────────────────────────────────────────

function emptyTypeDistribution(): TypeDistribution {
  return { decision: 0, gotcha: 0, runbook: 0, convention: 0, service: 0, concept: 0 };
}

function emptyConfidenceDistribution(): ConfidenceDistribution {
  return { high: 0, medium: 0, low: 0 };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return Math.round(sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!));
}

/**
 * Build the signal-to-noise report from a set of outcomes.
 */
export function buildReport(
  provider: ResolvedProvider | null,
  outcomes: F1Outcome[],
  fixtures: (F1PromptContext & { label: string })[],
): SignalReport {
  const details: EventDetail[] = outcomes.map((o, i) => ({
    index: i,
    label: fixtures[i]?.label ?? `fixture-${i}`,
    channel: fixtures[i]?.channel ?? 'unknown',
    kind: fixtures[i]?.kind ?? 'unknown',
    outcome: o.kind,
    latencyMs: o.latencyMs,
    outputSummary:
      o.kind === 'extract'
        ? { action: 'extract', type: o.output.type, title: o.output.title, path: o.output.path, confidence: o.output.confidence }
        : o.kind === 'llm_skip'
          ? { action: 'skip', reason: o.reason }
          : o.kind === 'prefilter_skip'
            ? { action: 'skip', reason: o.reason, source: 'prefilter' }
            : null,
    errorCode:
      o.kind === 'schema_failure' || o.kind === 'provider_failure'
        ? o.errorCode ?? null
        : null,
    errorMessage:
      o.kind === 'schema_failure' || o.kind === 'provider_failure'
        ? o.errorMessage ?? null
        : null,
  }));

  const extracts = outcomes.filter((o) => o.kind === 'extract');
  const prefilterSkips = outcomes.filter((o) => o.kind === 'prefilter_skip');
  const llmSkips = outcomes.filter((o) => o.kind === 'llm_skip');
  const schemaFailures = outcomes.filter((o) => o.kind === 'schema_failure');
  const providerFailures = outcomes.filter((o) => o.kind === 'provider_failure');
  const totalSkip = prefilterSkips.length + llmSkips.length;

  // Type distribution among extracts.
  const typeDist = emptyTypeDistribution();
  for (const e of extracts) {
    if (e.kind === 'extract') {
      const t = e.output.type;
      if (t in typeDist) {
        typeDist[t as keyof TypeDistribution]++;
      }
    }
  }

  // Confidence distribution among extracts.
  const confDist = emptyConfidenceDistribution();
  for (const e of extracts) {
    if (e.kind === 'extract') {
      const c = e.output.confidence;
      if (c in confDist) {
        confDist[c as keyof ConfidenceDistribution]++;
      }
    }
  }

  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const avg =
    latencies.length > 0
      ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length)
      : 0;

  const totalExtract = extracts.length;
  const signalRatio =
    totalExtract + totalSkip > 0
      ? totalExtract / (totalExtract + totalSkip)
      : 0;

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    provider: provider?.kind,
    model: provider?.model,
    totalEvents: outcomes.length,
    summary: {
      extract: totalExtract,
      prefilterSkip: prefilterSkips.length,
      llmSkip: llmSkips.length,
      totalSkip,
      schemaFailure: schemaFailures.length,
      providerFailure: providerFailures.length,
      signalRatio: Math.round(signalRatio * 1000) / 1000,
    },
    typeDistribution: typeDist,
    confidenceDistribution: confDist,
    latencyMs: {
      min: latencies[0] ?? 0,
      max: latencies[latencies.length - 1] ?? 0,
      avg,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    details,
    invariants: {
      // Schema failures must carry error info in details, never output data.
      schemaFailuresNotDowngraded: details
        .filter((d) => d.outcome === 'schema_failure')
        .every(
          (d) =>
            d.errorCode !== null &&
            d.errorMessage !== null &&
            d.outputSummary === null,
        ),
      // Extract details must carry valid outputSummary with required fields.
      extractsHaveValidOutput: details
        .filter((d) => d.outcome === 'extract')
        .every((d) => {
          const s = d.outputSummary as Record<string, unknown> | null;
          return (
            s !== null &&
            s['action'] === 'extract' &&
            typeof s['type'] === 'string' &&
            typeof s['title'] === 'string' &&
            typeof s['path'] === 'string' &&
            typeof s['confidence'] === 'string'
          );
        }),
      // Per-kind counts in details must match the summary totals.
      detailCountsMatchSummary:
        details.filter((d) => d.outcome === 'extract').length ===
          totalExtract &&
        details.filter((d) => d.outcome === 'prefilter_skip').length ===
          prefilterSkips.length &&
        details.filter((d) => d.outcome === 'llm_skip').length ===
          llmSkips.length &&
        details.filter((d) => d.outcome === 'schema_failure').length ===
          schemaFailures.length &&
        details.filter((d) => d.outcome === 'provider_failure').length ===
          providerFailures.length,
      // Every input fixture produced exactly one outcome.
      allEventsProcessed: outcomes.length === fixtures.length,
    },
  };
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the full F1 signal-to-noise measurement over a set of events.
 *
 * @param inputPath - Optional path to a JSON fixture file.
 * @param log       - Optional logger (for progress output).
 * @returns A report (either `SignalReport` with status 'ok' or
 *          `SkippedReport` with status 'skipped').
 */
export async function runSignalToNoise(
  inputPath?: string,
  log: (msg: string) => void = () => {},
): Promise<SignalReport | SkippedReport> {
  const provider = resolveProvider();

  if (!provider) {
    const skipped: SkippedReport = {
      status: 'skipped',
      reason:
        'No BYO LLM provider configured. Set one of TEAMEM_OPENAI_API_KEY, ' +
        'TEAMEM_ANTHROPIC_API_KEY, TEAMEM_OPENROUTER_API_KEY, or ' +
        'TEAMEM_OPENAI_COMPAT_BASE_URL + TEAMEM_OPENAI_COMPAT_API_KEY.',
      timestamp: new Date().toISOString(),
    };
    return skipped;
  }

  log(`[M1-F1-04] Provider: ${provider.kind}, Model: ${provider.model}`);

  const fixtures = loadFixtures(inputPath);
  log(`[M1-F1-04] Loaded ${fixtures.length} events`);

  const outcomes: F1Outcome[] = [];
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]!;
    log(`[M1-F1-04] [${String(i + 1).padStart(2, ' ')}/${fixtures.length}] ${fixture.label}`);
    const outcome = await runOneEvent(
      provider.client,
      fixture,
      `m1-f1-signal-${i}`,
    );
    outcomes.push(outcome);
    log(`           -> ${outcome.kind} (${outcome.latencyMs}ms)`);
  }

  return buildReport(provider, outcomes, fixtures);
}
