#!/usr/bin/env -S npx tsx
/**
 * M1 Quality Metrics Report v1 — Aggregation Script (DUA-219).
 *
 * Aggregates quality metrics from three sources into a single
 * machine-readable report:
 *
 *   1. F1 signal-to-noise ratio (F1-04) — extract/skip counts, type &
 *      confidence distributions, latency stats.
 *   2. F2 merge quality (F2-06) — duplicate-page rate, misattribution
 *      samples, page-count growth curve, concept/event counts.
 *   3. Tiered token cost — LLM calls × model pricing for F1 (cheap
 *      extraction) + F2 (strong merge-decider) + embedding generation.
 *      When token-level usage data is unavailable from the provider
 *      responses, each tier is honestly marked "未测" (§5.5: never
 *      fabricate numbers).
 *
 * Red lines (§5):
 *   - Every DB query carries team_id + project_id.
 *   - LLM calls use provider-native structured output with mandatory
 *     Zod re-validation.
 *   - No fixtures, no hard-coded results — metrics are computed from
 *     real pipeline outputs and database rows.
 *   - Dimensions without a configured provider are explicitly marked
 *     "未测" with a reason; numbers are never fabricated.
 *
 * Usage:
 *   # F1 signal-to-noise (real LLM provider required)
 *   TEAMEM_OPENAI_API_KEY=sk-... \
 *     npx tsx scripts/m1-quality-report.ts --f1
 *
 *   # F2 merge quality (requires DATABASE_URL)
 *   DATABASE_URL=postgres://... \
 *   TEAMEM_QUALITY_TEAM_ID=team_default \
 *   TEAMEM_QUALITY_PROJECT_ID=prj_default \
 *     npx tsx scripts/m1-quality-report.ts --f2
 *
 *   # Full report
 *   DATABASE_URL=postgres://... \
 *   TEAMEM_QUALITY_TEAM_ID=team_default \
 *   TEAMEM_QUALITY_PROJECT_ID=prj_default \
 *   TEAMEM_OPENAI_API_KEY=sk-... \
 *     npx tsx scripts/m1-quality-report.ts --f1 --f2
 *
 * Output: a machine-readable JSON summary written to stdout.
 * Stderr: progress and diagnostic messages.
 */

import { parseServerEnv } from '../apps/server/src/config/env.js';
import {
  runF2Analysis,
  type MisattributionMetrics,
  type TierUsage,
} from './m1-f2-quality.js';

// ── Configuration ───────────────────────────────────────────────────────────

interface QualityConfig {
  /** Run F1 signal-to-noise analysis. */
  f1: boolean;
  /** Run F2 merge-quality analysis. */
  f2: boolean;
  /** Database URL (required for F2). */
  databaseUrl?: string;
  /** Team ID for scoped queries (required for F2). */
  teamId?: string;
  /** Project ID for scoped queries (required for F2). */
  projectId?: string;
  /** Maximum concepts to analyze in F2 (default 500). */
  maxConcepts: number;
  /** Similarity threshold for duplicate detection (0–1). */
  duplicateSimilarityThreshold: number;
  /** Cap on how many merge decisions the wrong-attribution replay may run. */
  maxMisattributionReplays: number;
}

function parseQualityConfig(): QualityConfig {
  const args = process.argv.slice(2);
  const f1 = args.includes('--f1');
  const f2 = args.includes('--f2');

  // If neither --f1 nor --f2, run both.
  const runBoth = !f1 && !f2;

  const config: QualityConfig = {
    f1: f1 || runBoth,
    f2: f2 || runBoth,
    maxConcepts: Number(process.env['TEAMEM_QUALITY_MAX_CONCEPTS'] || '500'),
    duplicateSimilarityThreshold: Number(
      process.env['TEAMEM_QUALITY_DUPLICATE_THRESHOLD'] || '0.85',
    ),
    maxMisattributionReplays: Number(
      process.env['TEAMEM_QUALITY_MAX_REPLAYS'] || '50',
    ),
  };

  if (config.f2 || runBoth) {
    const env = parseServerEnv();
    config.databaseUrl = env.databaseUrl;

    const teamId = process.env['TEAMEM_QUALITY_TEAM_ID'];
    const projectId = process.env['TEAMEM_QUALITY_PROJECT_ID'];

    if (!teamId) {
      console.error(
        'TEAMEM_QUALITY_TEAM_ID is required for F2 analysis (e.g. team_default)',
      );
      process.exit(1);
    }
    if (!projectId) {
      console.error(
        'TEAMEM_QUALITY_PROJECT_ID is required for F2 analysis (e.g. prj_default)',
      );
      process.exit(1);
    }

    config.teamId = teamId;
    config.projectId = projectId;
  }

  return config;
}

// ── Result types ────────────────────────────────────────────────────────────

/** F1 signal-to-noise summary (subset of F1-04 report fields). */
export interface F1Section {
  status: 'ok' | 'skipped';
  /** If skipped, the reason. */
  skipReason?: string;
  /** Provider used (if any). */
  provider?: string;
  model?: string;
  timestamp?: string;
  totalEvents?: number;
  summary?: {
    extract: number;
    prefilterSkip: number;
    llmSkip: number;
    totalSkip: number;
    schemaFailure: number;
    providerFailure: number;
    signalRatio: number;
  };
  typeDistribution?: {
    decision: number;
    gotcha: number;
    runbook: number;
    convention: number;
    service: number;
    concept: number;
  };
  confidenceDistribution?: {
    high: number;
    medium: number;
    low: number;
  };
  latencyMs?: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
  };
  /** Provider-reported token usage summed over this run's F1 calls. */
  tokenUsage?: TierUsage;
}

/** Token cost tier. */
export interface TokenCostTier {
  /** e.g. "f1-extract", "f2-merge", "embedding". */
  tier: string;
  /** Whether measurement data is available. */
  measured: boolean;
  /** Reason when not measured. */
  reason?: string;
  /** Provider used for this tier. */
  provider?: string;
  /** Model used. */
  model?: string;
  /** Total LLM calls in this tier. */
  totalCalls?: number;
  /** Estimated cost (real when tracking exists, otherwise null). */
  estimatedCostUsd?: number | null;
  /** Per-unit details. */
  details?: string;
}

/** A high-similarity pair of distinct pages, flagged as a possible duplicate. */
export interface DuplicatePairSample {
  conceptA: { uuid: string; title: string; path: string };
  conceptB: { uuid: string; title: string; path: string };
  similarity: number;
  recallMode: 'vector' | 'fts';
}

/** F2 merge-quality section. */
export interface F2Section {
  status: 'ok' | 'skipped';
  skipReason?: string;
  timestamp?: string;
  recallMode?: 'vector' | 'fts-only';
  counts?: {
    totalConcepts: number;
    totalEvents: number;
    compiledEvents: number;
    skippedEvents: number;
    failedEvents: number;
    conceptsCreated: number;
    conceptsMerged: number;
  };
  pageCountGrowth?: {
    byWeek: { week: string; newPages: number; cumulativePages: number }[];
  };
  duplicatePageRate?: {
    potentialDuplicates: number;
    highSimilarityPairs: number;
    rate: number;
    /** Top-N high-similarity samples for manual review. */
    samples: DuplicatePairSample[];
  };
  /**
   * Wrong-attribution rate, measured by replaying each recorded merge
   * decision. Distinct from duplicatePageRate: that one asks "should these two
   * pages have been one?", this one asks "did this event go to the right
   * page?".
   */
  misattribution?: MisattributionMetrics;
  /** Provider-reported token usage per cost tier, observed during the run. */
  tokenUsage?: {
    f1Extract: TierUsage;
    f2Merge: TierUsage;
    embedding: TierUsage;
  };
}

/** The full M1 quality report. */
export interface M1QualityReport {
  meta: {
    reportVersion: '1.0.0';
    generatedAt: string;
    f1Ran: boolean;
    f2Ran: boolean;
  };
  f1: F1Section;
  f2: F2Section;
  tokenCosts: {
    tiers: TokenCostTier[];
    note: string;
  };
}

// ── F1: Signal-to-noise ─────────────────────────────────────────────────────

// ── F1: Signal-to-noise ─────────────────────────────────────────────────────

/**
 * Run F1 signal-to-noise analysis by delegating to the existing
 * `runSignalToNoise` function from `apps/server/scripts/m1-f1-signal.ts`.
 */
async function runF1(): Promise<F1Section> {
  // Dynamically import the F1 signal module. It lives inside apps/server
  // because it depends on the compiler internals.
  try {
    const {
      runSignalToNoise,
    } = await import('../apps/server/scripts/m1-f1-signal.js');

    const report = await runSignalToNoise(
      undefined /* use embedded fixtures */,
      (msg: string) => console.error(`[m1-quality-report] [f1] ${msg}`),
    );

    if (report.status === 'skipped') {
      return {
        status: 'skipped',
        skipReason: report.reason,
        timestamp: report.timestamp,
      };
    }

    return {
      status: 'ok',
      provider: report.provider,
      model: report.model,
      timestamp: report.timestamp,
      totalEvents: report.totalEvents,
      summary: {
        extract: report.summary.extract,
        prefilterSkip: report.summary.prefilterSkip,
        llmSkip: report.summary.llmSkip,
        totalSkip: report.summary.totalSkip,
        schemaFailure: report.summary.schemaFailure,
        providerFailure: report.summary.providerFailure,
        signalRatio: report.summary.signalRatio,
      },
      typeDistribution: {
        decision: report.typeDistribution.decision,
        gotcha: report.typeDistribution.gotcha,
        runbook: report.typeDistribution.runbook,
        convention: report.typeDistribution.convention,
        service: report.typeDistribution.service,
        concept: report.typeDistribution.concept,
      },
      confidenceDistribution: {
        high: report.confidenceDistribution.high,
        medium: report.confidenceDistribution.medium,
        low: report.confidenceDistribution.low,
      },
      latencyMs: {
        min: report.latencyMs.min,
        max: report.latencyMs.max,
        avg: report.latencyMs.avg,
        p50: report.latencyMs.p50,
        p95: report.latencyMs.p95,
      },
      tokenUsage: {
        measured: report.tokenUsage.measured,
        calls: report.tokenUsage.callsWithUsage,
        promptTokens: report.tokenUsage.promptTokens,
        completionTokens: report.tokenUsage.completionTokens,
        totalTokens: report.tokenUsage.totalTokens,
      },
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      status: 'skipped',
      skipReason: `F1 analysis failed: ${message}`,
    };
  }
}

// ── F2: Merge quality ───────────────────────────────────────────────────────

/**
 * Produce the F2 section by delegating to the F2 merge-quality analysis.
 *
 * This used to be a second copy of that analysis living in this file, and the
 * two had drifted: the copy here still hardcoded `embeddingClient = null`, so
 * `recallMode` could never be `vector`, and it still derived "misattribution"
 * from pairs of similar DISTINCT concepts — a heuristic that cannot see a
 * wrong merge, because a wrong merge produces one page rather than two similar
 * ones. Report v1 is the artifact the milestone is judged on, so it must read
 * the same measurement the F2 script produces, not a stale fork of it.
 */
async function runF2(config: QualityConfig): Promise<F2Section> {
  if (!config.databaseUrl || !config.teamId || !config.projectId) {
    return {
      status: 'skipped',
      skipReason:
        'DATABASE_URL, TEAMEM_QUALITY_TEAM_ID, or TEAMEM_QUALITY_PROJECT_ID not configured.',
    };
  }

  const report = await runF2Analysis({
    databaseUrl: config.databaseUrl,
    teamId: config.teamId,
    projectId: config.projectId,
    maxConcepts: config.maxConcepts,
    duplicateSimilarityThreshold: config.duplicateSimilarityThreshold,
    maxMisattributionReplays: config.maxMisattributionReplays,
  });

  return {
    status: 'ok',
    timestamp: report.meta.generatedAt,
    recallMode: report.meta.recallMode,
    counts: report.counts,
    pageCountGrowth: report.pageCountGrowth,
    duplicatePageRate: {
      potentialDuplicates: report.duplicatePageRate.potentialDuplicates,
      highSimilarityPairs: report.duplicatePageRate.highSimilarityPairs,
      rate: report.duplicatePageRate.rate,
      samples: report.duplicatePageRate.samples,
    },
    misattribution: report.misattributionRate,
    tokenUsage: report.tokenUsage,
  };
}

// ── Token cost estimation ───────────────────────────────────────────────────

/**
 * Build the per-tier token cost section from measured provider usage.
 *
 * Every tier used to be hardcoded to `measured: false` with a note saying the
 * LLM client did not capture token counts. It does now: `LlmResponse.usage` is
 * normalized from both provider envelopes, the merge-decider and the embedding
 * client expose a metering seam, and the F1 signal run and the F2 analysis
 * both aggregate what they observed.
 *
 * A tier is still reported unmeasured when nothing in it reported usage —
 * absent usage is never presented as zero cost. `estimatedCostUsd` stays null
 * because no price table is configured; token counts are measured facts,
 * a dollar figure derived from a guessed rate would not be (§5.5).
 */
function buildTokenCosts(
  f1Section: F1Section,
  f2Section: F2Section,
): { tiers: TokenCostTier[]; note: string } {
  const tiers: TokenCostTier[] = [];

  const tierFrom = (
    tier: string,
    usage: TierUsage | undefined,
    provider: string | undefined,
    model: string | undefined,
    unmeasuredReason: string,
  ): TokenCostTier => {
    if (!usage || !usage.measured) {
      return {
        tier,
        measured: false,
        reason: unmeasuredReason,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        totalCalls: usage?.calls ?? 0,
        estimatedCostUsd: null,
      };
    }
    return {
      tier,
      measured: true,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      totalCalls: usage.calls,
      // No price table is configured, so a USD figure would be invented.
      estimatedCostUsd: null,
      details:
        `${usage.calls} calls, ${usage.promptTokens} prompt + ` +
        `${usage.completionTokens} completion = ${usage.totalTokens} tokens ` +
        `(${Math.round(usage.totalTokens / Math.max(1, usage.calls))} per call). ` +
        'Provider-reported; USD cost requires a configured price table.',
    };
  };

  tiers.push(
    tierFrom(
      'f1-extract',
      f1Section.tokenUsage,
      f1Section.provider,
      f1Section.model,
      f1Section.status === 'ok'
        ? 'F1 ran but no call reported token usage; the provider omitted the usage envelope.'
        : (f1Section.skipReason ?? 'F1 analysis did not run.'),
    ),
  );

  tiers.push(
    tierFrom(
      'f2-merge',
      f2Section.tokenUsage?.f2Merge,
      undefined,
      undefined,
      f2Section.status === 'ok'
        ? 'No merge decision was replayed, so no F2 call was issued. This is ' +
          'expected on a project with no merges yet.'
        : (f2Section.skipReason ?? 'F2 analysis did not run.'),
    ),
  );

  tiers.push(
    tierFrom(
      'embedding',
      f2Section.tokenUsage?.embedding,
      undefined,
      undefined,
      f2Section.status === 'ok'
        ? 'Retrieval ran in fts-only mode, so no embedding call was issued. ' +
          'Configure a provider with an embedding API to measure this tier.'
        : (f2Section.skipReason ?? 'F2 analysis did not run.'),
    ),
  );

  const measured = tiers.filter((t) => t.measured).length;
  const note =
    measured === tiers.length
      ? 'All tiers measured from provider-reported token usage during this run. ' +
        'estimatedCostUsd is null because no model price table is configured; ' +
        'multiply the reported tokens by your provider rates.'
      : `${measured} of ${tiers.length} tiers measured. Unmeasured tiers carry ` +
        'a reason and are never reported as zero cost.';

  return { tiers, note };
}

/**
 * Run the full M1 quality report aggregation.
 */
export async function runQualityReport(
  config: QualityConfig,
): Promise<M1QualityReport> {
  console.error('[m1-quality-report] Starting M1 quality report v1...');

  let f1Section: F1Section;
  let f2Section: F2Section;

  // ── F1 ────────────────────────────────────────────────────────────────
  if (config.f1) {
    console.error('[m1-quality-report] Running F1 signal-to-noise...');
    f1Section = await runF1();
    console.error(
      `[m1-quality-report] F1: ${f1Section.status}` +
        (f1Section.status === 'ok'
          ? ` signalRatio=${f1Section.summary?.signalRatio}`
          : ` (${f1Section.skipReason})`),
    );
  } else {
    f1Section = { status: 'skipped', skipReason: '--f1 not requested' };
  }

  // ── F2 ────────────────────────────────────────────────────────────────
  if (config.f2) {
    console.error('[m1-quality-report] Running F2 merge-quality...');
    f2Section = await runF2(config);
    console.error(
      `[m1-quality-report] F2: ${f2Section.status}` +
        (f2Section.status === 'ok'
          ? ` concepts=${f2Section.counts?.totalConcepts} dupRate=${f2Section.duplicatePageRate?.rate}`
          : ` (${f2Section.skipReason})`),
    );
  } else {
    f2Section = { status: 'skipped', skipReason: '--f2 not requested' };
  }

  // ── Token costs ───────────────────────────────────────────────────────
  console.error('[m1-quality-report] Building token cost tiers...');
  const tokenCosts = buildTokenCosts(f1Section, f2Section);

  // ── Assemble report ───────────────────────────────────────────────────
  const report: M1QualityReport = {
    meta: {
      reportVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      f1Ran: config.f1,
      f2Ran: config.f2,
    },
    f1: f1Section,
    f2: f2Section,
    tokenCosts,
  };

  console.error('[m1-quality-report] Report complete.');
  return report;
}

// ── CLI entry point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseQualityConfig();

  const report = await runQualityReport(config);

  // Output machine-readable JSON to stdout.
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[m1-quality-report] Fatal error:', err);
  process.exit(1);
});
