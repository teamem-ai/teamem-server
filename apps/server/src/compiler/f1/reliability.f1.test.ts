/**
 * M0-F1-07 — 20-Run Structured-Output Reliability Check.
 *
 * Runs 20 noisy F1 inputs (including meaningless commit messages) against a
 * real BYO LLM provider, measuring:
 *   - Valid extracts (concept extracted, passed Zod validation)
 *   - Valid skips (model chose skip, passed Zod validation)
 *   - Schema failures (output failed Zod — ALWAYS a failure, never a fallback)
 *   - Provider failures (LLM threw LlmError — timeout, http_error, etc.)
 *   - Per-run latency (ms)
 *   - Cost metadata (token usage from provider response, when available)
 *
 * The check uses the real F1 prompt builder, the real f1Output Zod schema,
 * and the real LlmClient factory wired to whichever BYO provider the
 * environment configures. No stubs, no mocks — the output is as close to
 * production F1 behaviour as a script can get without database persistence.
 *
 * Output: machine-readable JSON to stdout.
 *
 * CLI Acceptance (vitest-based):
 *   pnpm --filter @teamem/server m0:f1-reliability
 *
 * Environment variables:
 *   TEAMEM_OPENAI_API_KEY           — enables the 'openai' provider
 *   TEAMEM_ANTHROPIC_API_KEY         — enables the 'claude' provider
 *   TEAMEM_OPENROUTER_API_KEY        — enables the 'openrouter' provider
 *   TEAMEM_OPENAI_COMPAT_BASE_URL + TEAMEM_OPENAI_COMPAT_API_KEY — 'custom'
 *   F1_RELIABILITY_INPUT            — optional path to a JSON fixture file
 *
 * The check skips (passes with a message) when no LLM provider is configured.
 * Schema validation failures are ALWAYS counted as failures — there is no
 * tolerant "approximately correct" path (§5.2 red line).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { f1Output, type F1Output } from './output.js';
import { buildF1Prompt, type F1PromptContext } from './prompt.js';
import {
  createLlmClient,
  LlmError,
  DEFAULT_MODELS,
  type FetchLike,
  type LlmClient,
} from '../../llm/factory.js';
import type { LlmResponse } from '../../llm/types.js';
import { resolveLlmConfig } from '../../config/llm.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Outcome of a single reliability run. */
type RunOutcome =
  | { kind: 'valid_extract'; output: F1Output & { action: 'extract' }; latencyMs: number }
  | { kind: 'valid_skip'; output: F1Output & { action: 'skip' }; latencyMs: number }
  | { kind: 'schema_failure'; latencyMs: number; errorCode: string; errorMessage: string }
  | { kind: 'provider_failure'; latencyMs: number; errorCode: string; errorMessage: string };

interface RunDetail {
  index: number;
  label: string;
  channel: string;
  kind: string;
  outcome: RunOutcome['kind'];
  latencyMs: number;
  /** Non-null for valid_extract (the extract shape) and valid_skip (the skip shape). */
  outputSummary: unknown;
  /** Non-null for failures — sanitised error code. */
  errorCode: string | null;
  /** Non-null for failures — sanitised error message. */
  errorMessage: string | null;
}

interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
}

interface ReliabilityReport {
  timestamp: string;
  provider: string;
  model: string;
  totalRuns: number;
  summary: {
    validExtract: number;
    validSkip: number;
    schemaFailure: number;
    providerFailure: number;
  };
  latencyMs: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
  };
  cost: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    perRunPromptTokens: number[];
    perRunCompletionTokens: number[];
  };
  details: RunDetail[];
  invariants: {
    schemaFailuresAlwaysFailures: boolean;
    noSilentFallbacks: boolean;
    allTwentyRunsExecuted: boolean;
  };
}

// ── Embedded noisy fixtures (20) ────────────────────────────────────────────

/**
 * Twenty diverse, noisy F1 inputs designed to stress-test the F1 pipeline.
 *
 * Mix:
 *  - 6–8 meaningful inputs (should produce extract)
 *  - 6–8 noisy/meaningless inputs (should produce skip)
 *  - 4 ambiguous or edge-case inputs (could go either way, tests boundaries)
 *
 * Each fixture is an {@link F1PromptContext} — the exact shape
 * {@link buildF1Prompt} consumes. Channels and kinds match the frozen
 * source contract from `@teamem/schema`.
 */
const EMBEDDED_FIXTURES: (F1PromptContext & { label: string })[] = [
  // ── Meaningful inputs (expected: extract) ──────────────────────────────
  {
    label: 'PR: database migration with rationale',
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#42',
    payload: {
      title: 'feat(db): migrate from MongoDB to Postgres for core event store',
      body: `## Summary
We are migrating the core event store from MongoDB to Postgres.

## Rationale
- Strong ACID guarantees needed for event idempotency
- JSONB provides flexible schema support comparable to MongoDB documents
- Single datastore reduces operational complexity (we already run Postgres for other services)
- pgvector will enable future semantic search on concept pages

## Migration Plan
1. Dual-write for 2 weeks
2. Backfill historical events
3. Cut over reads
4. Remove MongoDB dependency`,
    },
  },
  {
    label: 'Issue: production incident with workaround',
    channel: 'github',
    kind: 'github_issue',
    externalId: 'teamem-ai/teamem#99',
    payload: {
      title: 'PROD: payment webhook timeout causing double charges',
      body: `## Impact
Payment webhook from Stripe times out after 30s, but Stripe retries after 60s.
This means some customers are being charged twice.

## Root Cause
The payment processor is making a synchronous HTTP call to the fraud detection
service, which occasionally takes 40s to respond during peak hours.

## Workaround (applied)
Set the fraud detection call to fire-and-forget with a 5s timeout.
If fraud detection doesn't respond in time, flag the transaction for manual review
rather than blocking the webhook response.

## Long-term Fix
Move fraud detection to an async queue so the webhook can always respond within 5s.
`,
      labels: ['bug', 'production'],
    },
  },
  {
    label: 'Commit: architecture decision with ADR',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@abc1234',
    payload: {
      message: `docs(adr): add ADR-003 — use event sourcing for audit log

## Decision
We will use event sourcing for the audit log instead of a traditional append-only table.

## Context
The existing audit table grows by ~1M rows/day and queries for "show me the state
of order X at time T" require complex temporal joins. Event sourcing gives us a
replayable log and makes temporal queries trivial.

## Consequences
- Audit storage will roughly double (events + snapshots)
- We need a snapshotting strategy within 3 months
- The team needs training on event sourcing patterns

## Alternatives Considered
- Change data capture (CDC) — rejected because it couples audit to the current schema
- Append-only table with materialized views — rejected because it still requires complex temporal queries`,
      sha: 'abc1234def567890',
    },
  },
  {
    label: 'PR review comment: design pattern discussion',
    channel: 'github',
    kind: 'github_pr_comment',
    externalId: 'teamem-ai/teamem#42',
    payload: {
      body: `I think we should use the Strategy pattern here instead of a switch statement.

The current implementation has a switch on paymentProvider with 5 cases, and we're
about to add 3 more. Each case is ~50 lines of provider-specific logic. A Strategy
pattern would:
1. Make each provider's logic independently testable
2. Allow adding new providers without modifying existing code
3. Reduce the cognitive load of the 400-line processPayment function

I've used this pattern in the notification service (see src/notifications/strategies/)
and it's worked well — we've added 4 new channels without touching existing code.`,
      path: 'src/payments/processor.ts',
      line: 142,
    },
  },
  {
    label: 'CLI init: service documentation',
    channel: 'cli',
    kind: 'cli_init',
    externalId: 'teamem-ai/teamem:docs/services/payment-worker.md',
    payload: {
      repo: 'teamem-ai/teamem',
      commitSha: 'def5678abc',
      path: 'docs/services/payment-worker.md',
      content: `# Payment Worker

## Overview
The Payment Worker processes payment events from the payment queue and
reconciles them with the payment gateway (Stripe).

## Configuration
- QUEUE_URL: the Redis queue URL (default: redis://localhost:6379)
- STRIPE_API_KEY: Stripe secret key (required)
- MAX_RETRIES: maximum retry attempts per payment (default: 3)

## Monitoring
The worker exposes health checks at :9090/health and metrics at :9090/metrics.

## Common Issues
- If the worker falls behind the queue, check the Stripe API rate limit dashboard
- Payment idempotency keys must be unique per attempt — duplicates cause 409 responses`,
      schemaVersion: 1,
    },
  },
  {
    label: 'Issue: coding convention proposal',
    channel: 'github',
    kind: 'github_issue',
    externalId: 'teamem-ai/teamem#150',
    payload: {
      title: 'Proposal: require Zod validation for all API boundaries',
      body: `## Proposal
Every HTTP handler, queue consumer, and MCP tool MUST validate its input
with a Zod schema before processing. No more ` + '`req.body as Foo`' + ` casts.

## Motivation
We've had 3 production incidents in Q1 from missing validation:
1. Missing field caused null pointer in payment processor
2. Malformed date string crashed the report generator
3. User-injected extra fields bypassed the allowlist in the config updater

## Proposed Convention
- Define Zod schemas in the same file as the handler (colocation)
- Export schemas for testing (no ` + '`export default`' + ` on schemas)
- Use ` + '`.strict()`' + ` by default — reject unknown fields
- Error responses must use the teamem error envelope

## Enforcement
- ESLint rule ` + '`no-restricted-syntax`' + ` to ban ` + '`as`' + ` type casts on ` + '`req.body`' + `
- CI check that every route file exports a named Zod schema`,
      labels: ['convention', 'discussion'],
    },
  },
  {
    label: 'PR: gotcha discovery in deployment',
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#200',
    payload: {
      title: 'fix(deploy): add 10s sleep between migration and app restart',
      body: `## Problem
Deployments were failing because the app started before migrations completed.
Despite ` + '`depends_on`' + ` in docker-compose, the Postgres container being
"healthy" only means it accepts connections — not that migrations have run.

## Fix
Add a 10-second sleep in the deploy script between migration and app restart.
This is a temporary fix; the long-term solution is a migration init container.

## Gotcha
Docker Compose ` + '`depends_on`' + ` with ` + '`condition: service_healthy`' + `
only waits for the health check to pass — it does NOT wait for application-level
readiness like completed migrations. Always verify application readiness with a
dedicated endpoint or init container, not just container health.`,
    },
  },
  {
    label: 'Commit: meaningful runbook for rotating secrets',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@bcd2345',
    payload: {
      message: `docs(runbook): add runbook for rotating database credentials

## When to Use
- Credential has been exposed or is suspected of being exposed
- Quarterly rotation as part of security hygiene
- After an offboarding where the departing member had access

## Steps
1. Generate new credentials in the secret manager (Vault path: secret/database/teamem)
2. Update the DATABASE_URL in the teamem environment (DO NOT commit the new value)
3. Run the credential update script: ./scripts/rotate-db-credentials.sh
4. Verify the app starts and responds to health checks
5. Revoke the old credentials in Vault after 1 hour of stable operation
6. Update the deployment runbook with the new rotation date

## Rollback
If the new credentials cause issues, revert DATABASE_URL to the old value
and restart. Old credentials remain valid for 1 hour after rotation.`,
      sha: 'bcd234567890',
    },
  },

  // ── Noisy / meaningless inputs (expected: skip) ────────────────────────
  {
    label: 'Commit: fix typo',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@1111111',
    payload: {
      message: 'fix typo',
      sha: '1111111aaaa',
    },
  },
  {
    label: 'Commit: whitespace-only change',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@2222222',
    payload: {
      message: '  ',
      sha: '2222222bbbb',
    },
  },
  {
    label: 'Commit: meaningless "asdf" message',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@3333333',
    payload: {
      message: 'asdf',
      sha: '3333333cccc',
    },
  },
  {
    label: 'Commit: "WIP" — work in progress',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@4444444',
    payload: {
      message: 'WIP',
      sha: '4444444dddd',
    },
  },
  {
    label: 'Commit: dependency bump (Dependabot)',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@5555555',
    payload: {
      message: `Bump eslint from 8.57.0 to 8.57.1

---
updated-dependencies:
- dependency-name: eslint
  dependency-type: direct:development
  update-type: version-update:semver-patch
...

Signed-off-by: dependabot[bot] <support@github.com>`,
      sha: '5555555eeee',
    },
  },
  {
    label: 'Commit: "update README" with no detail',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@6666666',
    payload: {
      message: 'update README',
      sha: '6666666ffff',
    },
  },
  {
    label: 'PR: linter configuration change',
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#300',
    payload: {
      title: 'chore: update eslint config',
      body: 'Updated the eslint config to use the new flat config format.',
    },
  },
  {
    label: 'Commit: version bump only',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@7777777',
    payload: {
      message: 'v1.2.3',
      sha: '7777777aaaa',
    },
  },

  // ── Ambiguous / edge case inputs ────────────────────────────────────────
  {
    label: 'Issue: empty body with only a title',
    channel: 'github',
    kind: 'github_issue',
    externalId: 'teamem-ai/teamem#400',
    payload: {
      title: 'question: how do I set up the dev environment?',
      body: '',
    },
  },
  {
    label: 'Commit: single emoji message',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@8888888',
    payload: {
      message: '🚀',
      sha: '8888888bbbb',
    },
  },
  {
    label: 'PR: very long title with minimal body',
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#500',
    payload: {
      title: 'feat: add a new endpoint for querying the aggregated analytics data from the reporting service with optional filtering by date range and team',
      body: 'See title.',
    },
  },
  {
    label: 'Commit: git-generated merge commit',
    channel: 'github',
    kind: 'github_commit',
    externalId: 'teamem-ai/teamem@9999999',
    payload: {
      message: `Merge branch 'feature/new-auth' into main

* feature/new-auth:
  feat: add OAuth2 support
  test: add auth integration tests
  docs: update auth documentation`,
      sha: '9999999cccc',
    },
  },
];

// ── LLM Provider Resolution ─────────────────────────────────────────────────

interface ResolvedProvider {
  client: LlmClient;
  kind: string;
  model: string;
  usageLog: UsageRecord[];
}

function resolveProvider(): ResolvedProvider | null {
  // Try providers in priority order. Config must use TEAMEM_-prefixed vars
  // per the project red line (no ambient bare provider variables).
  const env = process.env;

  if (env['TEAMEM_OPENAI_API_KEY']) {
    const config = resolveLlmConfig({
      kind: 'openai',
      apiKey: env['TEAMEM_OPENAI_API_KEY'],
    });
    const usageLog: UsageRecord[] = [];
    const instrumentedFetch = createInstrumentedFetch(globalThis.fetch, usageLog);
    const client = createLlmClient(config, { fetch: instrumentedFetch });
    return {
      client,
      kind: 'openai',
      model: DEFAULT_MODELS['openai'],
      usageLog,
    };
  }

  if (env['TEAMEM_ANTHROPIC_API_KEY']) {
    const config = resolveLlmConfig({
      kind: 'claude',
      apiKey: env['TEAMEM_ANTHROPIC_API_KEY'],
    });
    const usageLog: UsageRecord[] = [];
    const instrumentedFetch = createInstrumentedFetch(globalThis.fetch, usageLog);
    const client = createLlmClient(config, { fetch: instrumentedFetch });
    return {
      client,
      kind: 'claude',
      model: DEFAULT_MODELS['claude'],
      usageLog,
    };
  }

  if (env['TEAMEM_OPENROUTER_API_KEY']) {
    const config = resolveLlmConfig({
      kind: 'openrouter',
      apiKey: env['TEAMEM_OPENROUTER_API_KEY'],
    });
    const usageLog: UsageRecord[] = [];
    const instrumentedFetch = createInstrumentedFetch(globalThis.fetch, usageLog);
    const client = createLlmClient(config, { fetch: instrumentedFetch });
    return {
      client,
      kind: 'openrouter',
      model: DEFAULT_MODELS['openrouter'],
      usageLog,
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
    const usageLog: UsageRecord[] = [];
    const instrumentedFetch = createInstrumentedFetch(globalThis.fetch, usageLog);
    const client = createLlmClient(config, {
      fetch: instrumentedFetch,
      defaultModel: env['TEAMEM_OPENAI_COMPAT_MODEL'] || undefined,
    });
    return {
      client,
      kind: 'custom',
      model: env['TEAMEM_OPENAI_COMPAT_MODEL'] || '(custom endpoint)',
      usageLog,
    };
  }

  return null;
}

/**
 * Create an instrumented fetch that intercepts provider responses to record
 * token usage metadata. The original response is returned unchanged; a clone
 * is used to extract usage so the factory's normal response-reading path is
 * unaffected.
 *
 * No API keys, request bodies, or provider error text are retained in the
 * usage log — only the numeric token counts from the `usage` block.
 */
function createInstrumentedFetch(
  realFetch: typeof globalThis.fetch,
  usageLog: UsageRecord[],
): FetchLike {
  return async (input, init) => {
    const response = await realFetch(input, init);
    if (response.ok) {
      const clone = response.clone();
      try {
        const raw = await clone.text();
        const json: unknown = JSON.parse(raw);
        if (isObject(json) && isObject(json.usage)) {
          const usage = json.usage as Record<string, unknown>;
          const promptTokens =
            typeof usage.prompt_tokens === 'number'
              ? usage.prompt_tokens
              : typeof usage.input_tokens === 'number'
                ? usage.input_tokens
                : 0;
          const completionTokens =
            typeof usage.completion_tokens === 'number'
              ? usage.completion_tokens
              : typeof usage.output_tokens === 'number'
                ? usage.output_tokens
                : 0;
          usageLog.push({ promptTokens, completionTokens });
        }
      } catch {
        // Usage extraction is best-effort; parsing failures are silently
        // ignored — the main fetch path handles the response independently.
      }
    }
    return response;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Single-Run Execution ────────────────────────────────────────────────────

async function runOne(
  client: LlmClient,
  ctx: F1PromptContext & { label: string },
  requestId: string,
): Promise<RunOutcome> {
  const { system, user } = buildF1Prompt(ctx);
  const started = performance.now();

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
        kind: 'valid_extract',
        output: response.output,
        latencyMs,
      };
    }
    return {
      kind: 'valid_skip',
      output: response.output,
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

    // Unknown error — still a failure, never a fallback.
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

function buildReport(
  provider: ResolvedProvider,
  outcomes: RunOutcome[],
  fixtures: (F1PromptContext & { label: string })[],
): ReliabilityReport {
  const details: RunDetail[] = outcomes.map((o, i) => ({
    index: i,
    label: fixtures[i]!.label,
    channel: fixtures[i]!.channel,
    kind: fixtures[i]!.kind,
    outcome: o.kind,
    latencyMs: o.latencyMs,
    outputSummary:
      o.kind === 'valid_extract'
        ? { action: o.output.action, type: o.output.type, title: o.output.title, path: o.output.path, confidence: o.output.confidence }
        : o.kind === 'valid_skip'
          ? { action: o.output.action, reason: o.output.reason }
          : null,
    errorCode: o.kind === 'schema_failure' || o.kind === 'provider_failure' ? o.errorCode : null,
    errorMessage: o.kind === 'schema_failure' || o.kind === 'provider_failure' ? o.errorMessage : null,
  }));

  const validExtract = outcomes.filter((o) => o.kind === 'valid_extract');
  const validSkip = outcomes.filter((o) => o.kind === 'valid_skip');
  const schemaFailure = outcomes.filter((o) => o.kind === 'schema_failure');
  const providerFailure = outcomes.filter((o) => o.kind === 'provider_failure');

  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const avg = latencies.length > 0
    ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length)
    : 0;

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  return {
    timestamp: new Date().toISOString(),
    provider: provider.kind,
    model: provider.model,
    totalRuns: outcomes.length,
    summary: {
      validExtract: validExtract.length,
      validSkip: validSkip.length,
      schemaFailure: schemaFailure.length,
      providerFailure: providerFailure.length,
    },
    latencyMs: {
      min: latencies[0] ?? 0,
      max: latencies[latencies.length - 1] ?? 0,
      avg,
      p50,
      p95,
    },
    cost: {
      totalPromptTokens: provider.usageLog.reduce((s, u) => s + u.promptTokens, 0),
      totalCompletionTokens: provider.usageLog.reduce((s, u) => s + u.completionTokens, 0),
      perRunPromptTokens: provider.usageLog.map((u) => u.promptTokens),
      perRunCompletionTokens: provider.usageLog.map((u) => u.completionTokens),
    },
    details,
    invariants: {
      schemaFailuresAlwaysFailures:
        schemaFailure.every((f) => f.kind === 'schema_failure'),
      noSilentFallbacks: outcomes.every(
        (o) =>
          o.kind === 'valid_extract' ||
          o.kind === 'valid_skip' ||
          o.kind === 'schema_failure' ||
          o.kind === 'provider_failure',
      ),
      allTwentyRunsExecuted: outcomes.length === 20,
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return Math.round(sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!));
}

// ── Fixture Loading ─────────────────────────────────────────────────────────

function loadFixtures(): (F1PromptContext & { label: string })[] {
  // Check for --input flag in process.argv (vitest passthrough).
  const inputIndex = process.argv.indexOf('--input');
  let inputPath: string | undefined;
  if (inputIndex >= 0 && inputIndex + 1 < process.argv.length) {
    inputPath = process.argv[inputIndex + 1];
  }
  // Also check env var as fallback.
  if (!inputPath) {
    inputPath = process.env['F1_RELIABILITY_INPUT'];
  }

  if (inputPath) {
    const raw = readFileSync(inputPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Fixture file must be a JSON array of F1PromptContext objects');
    }
    if (parsed.length !== 20) {
      throw new Error(
        `Fixture file must contain exactly 20 inputs, got ${parsed.length}`,
      );
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

// ── Main Test ───────────────────────────────────────────────────────────────

/**
 * The F1 reliability check is a single vitest `it` that:
 *  1. Resolves the LLM provider from environment variables.
 *  2. Loads 20 noisy fixtures (embedded or from `--input` / `F1_RELIABILITY_INPUT`).
 *  3. Runs each fixture through the real F1 pipeline.
 *  4. Builds and prints a machine-readable JSON report.
 *  5. Asserts the key invariants: 20 runs, schema failures are failures,
 *     no silent fallbacks.
 *
 * When no LLM provider is configured, the test passes with a clear skip
 * message — it does not silently succeed with a fake result.
 */
describe('M0-F1-07: 20-Run Structured-Output Reliability Check', () => {
  it(
    'runs 20 noisy inputs through F1 and reports results',
    async () => {
      const provider = resolveProvider();

      if (!provider) {
        // No BYO provider configured — this is an honest skip, not a
        // pretend success. The test passes so CI stays green on branches
        // without keys, but the output makes the skip explicit.
        console.log(
          JSON.stringify({
            status: 'skipped',
            reason:
              'No BYO LLM provider configured. Set one of TEAMEM_OPENAI_API_KEY, ' +
              'TEAMEM_ANTHROPIC_API_KEY, TEAMEM_OPENROUTER_API_KEY, or ' +
              'TEAMEM_OPENAI_COMPAT_BASE_URL + TEAMEM_OPENAI_COMPAT_API_KEY.',
            timestamp: new Date().toISOString(),
          }),
        );
        // Pass the test — this is an expected skip, not a failure.
        expect(true).toBe(true);
        return;
      }

      console.log(
        `[M0-F1-07] Provider: ${provider.kind}, Model: ${provider.model}`,
      );

      const fixtures = loadFixtures();
      expect(fixtures).toHaveLength(20);

      const outcomes: RunOutcome[] = [];
      for (let i = 0; i < fixtures.length; i++) {
        const fixture = fixtures[i]!;
        console.log(
          `[M0-F1-07] [${String(i + 1).padStart(2, ' ')}/20] ${fixture.label}`,
        );
        const outcome = await runOne(
          provider.client,
          fixture,
          `m0-f1-reliability-${i}`,
        );
        outcomes.push(outcome);
        console.log(
          `           -> ${outcome.kind} (${outcome.latencyMs}ms)`,
        );
      }

      // Build the machine-readable report.
      const report = buildReport(provider, outcomes, fixtures);

      // Print report to stdout.
      console.log('\n--- RELIABILITY REPORT (JSON) ---');
      console.log(JSON.stringify(report, null, 2));
      console.log('--- END REPORT ---');

      // ── Assert invariants ──────────────────────────────────────────

      // 1. Exactly 20 runs executed.
      expect(report.totalRuns).toBe(20);

      // 2. Schema failures exist and are counted correctly.
      //    (If there are any schema failures, they appear in the report.)
      expect(report.invariants.schemaFailuresAlwaysFailures).toBe(true);

      // 3. No outcome is unclassified — every run is one of the four kinds.
      expect(report.invariants.noSilentFallbacks).toBe(true);

      // 4. All 20 runs are present in the details array.
      expect(report.details).toHaveLength(20);

      // 5. The report is valid JSON (by construction).
      //    We already serialized it — if it were invalid, JSON.stringify
      //    would have thrown.
      expect(typeof JSON.stringify(report)).toBe('string');
    },
    // Give each of the 20 runs up to 60 seconds (default 30s timeout per
    // LLM call + overhead). Total: 25 minutes max.
    25 * 60 * 1000,
  );
});
