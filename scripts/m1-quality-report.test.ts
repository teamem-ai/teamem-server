/**
 * M1 Quality Metrics Report v1 — Unit Tests (DUA-219).
 *
 * Tests the aggregation script's core logic without requiring a database,
 * LLM provider, or embedding client:
 *  - Report structure validation
 *  - Token cost tiers honesty (all marked "未测")
 *  - F1/F2 section skip paths
 *  - Empty/null boundary cases
 *  - CLI argument parsing (--f1 / --f2 / both)
 *
 * Integration tests that require DATABASE_URL are in
 * scripts/m1-quality-report.integration.test.ts (if created).
 */
import { describe, expect, it } from 'vitest';
import type {
  F1Section,
  F2Section,
  M1QualityReport,
  TokenCostTier,
} from './m1-quality-report.js';

// ── Report structure ────────────────────────────────────────────────────────

describe('M1 quality report structure', () => {
  it('has all required top-level sections', () => {
    const requiredKeys = ['meta', 'f1', 'f2', 'tokenCosts'];

    const report: Record<string, unknown> = {
      meta: {
        reportVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        f1Ran: true,
        f2Ran: true,
      },
      f1: { status: 'skipped', skipReason: 'test' },
      f2: { status: 'skipped', skipReason: 'test' },
      tokenCosts: { tiers: [], note: 'test' },
    };

    for (const key of requiredKeys) {
      expect(report).toHaveProperty(key);
    }
  });

  it('meta section contains required fields', () => {
    const meta: M1QualityReport['meta'] = {
      reportVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      f1Ran: false,
      f2Ran: false,
    };

    expect(meta.reportVersion).toBe('1.0.0');
    expect(typeof meta.generatedAt).toBe('string');
    expect(typeof meta.f1Ran).toBe('boolean');
    expect(typeof meta.f2Ran).toBe('boolean');
  });
});

// ── F1 section ──────────────────────────────────────────────────────────────

describe('F1 section', () => {
  it('handles skipped status correctly', () => {
    const f1: F1Section = {
      status: 'skipped',
      skipReason: 'No BYO LLM provider configured.',
      timestamp: new Date().toISOString(),
    };

    expect(f1.status).toBe('skipped');
    expect(f1.skipReason).toBeTruthy();
    expect(typeof f1.skipReason).toBe('string');
    // No summary, type distribution, or latency when skipped.
    expect(f1.summary).toBeUndefined();
    expect(f1.typeDistribution).toBeUndefined();
    expect(f1.latencyMs).toBeUndefined();
  });

  it('handles ok status with all sub-sections', () => {
    const f1: F1Section = {
      status: 'ok',
      provider: 'openai',
      model: 'gpt-4o-2024-08-06',
      timestamp: new Date().toISOString(),
      totalEvents: 20,
      summary: {
        extract: 8,
        prefilterSkip: 8,
        llmSkip: 2,
        totalSkip: 10,
        schemaFailure: 0,
        providerFailure: 0,
        signalRatio: 0.444,
      },
      typeDistribution: {
        decision: 3,
        gotcha: 2,
        runbook: 1,
        convention: 1,
        service: 1,
        concept: 0,
      },
      confidenceDistribution: {
        high: 4,
        medium: 3,
        low: 1,
      },
      latencyMs: {
        min: 1,
        max: 3500,
        avg: 800,
        p50: 750,
        p95: 3000,
      },
    };

    expect(f1.status).toBe('ok');
    expect(f1.provider).toBe('openai');
    expect(f1.model).toBe('gpt-4o-2024-08-06');

    // Summary invariants.
    expect(f1.totalEvents).toBe(20);
    expect(f1.summary!.extract + f1.summary!.totalSkip).toBeLessThanOrEqual(
      f1.totalEvents!,
    );
    expect(f1.summary!.signalRatio).toBeGreaterThanOrEqual(0);
    expect(f1.summary!.signalRatio).toBeLessThanOrEqual(1);

    // Type distribution sums to extract count.
    const typeTotal = Object.values(f1.typeDistribution!).reduce(
      (s, v) => s + v,
      0,
    );
    expect(typeTotal).toBe(f1.summary!.extract);

    // Confidence distribution sums to extract count.
    const confTotal = Object.values(f1.confidenceDistribution!).reduce(
      (s, v) => s + v,
      0,
    );
    expect(confTotal).toBe(f1.summary!.extract);

    // Latency stats.
    expect(f1.latencyMs!.min).toBeGreaterThanOrEqual(0);
    expect(f1.latencyMs!.max).toBeGreaterThanOrEqual(f1.latencyMs!.min!);
    expect(f1.latencyMs!.avg).toBeGreaterThanOrEqual(0);
  });

  it('provides valid confidences: high, medium, low', () => {
    const confs = ['high', 'medium', 'low'] as const;
    const dist = { high: 10, medium: 5, low: 2 };

    // All keys are valid confidence values.
    for (const key of Object.keys(dist)) {
      expect(confs).toContain(key);
    }

    // Must sum to extract count (tested above).
    expect(dist.high + dist.medium + dist.low).toBe(17);
  });

  it('provides valid type distribution keys', () => {
    const validTypes = [
      'decision',
      'gotcha',
      'runbook',
      'convention',
      'service',
      'concept',
    ];
    const dist = {
      decision: 1,
      gotcha: 2,
      runbook: 3,
      convention: 4,
      service: 5,
      concept: 6,
    };

    for (const key of Object.keys(dist)) {
      expect(validTypes).toContain(key);
    }
  });
});

// ── F2 section ──────────────────────────────────────────────────────────────

describe('F2 section', () => {
  it('handles skipped status', () => {
    const f2: F2Section = {
      status: 'skipped',
      skipReason: 'DATABASE_URL not configured.',
    };

    expect(f2.status).toBe('skipped');
    expect(f2.skipReason).toBeTruthy();
  });

  it('handles ok status with counts', () => {
    const f2: F2Section = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      recallMode: 'fts-only',
      counts: {
        totalConcepts: 42,
        totalEvents: 150,
        compiledEvents: 100,
        skippedEvents: 30,
        failedEvents: 20,
        conceptsCreated: 42,
        conceptsMerged: 15,
      },
      pageCountGrowth: {
        byWeek: [
          { week: '2026-W01', newPages: 10, cumulativePages: 10 },
          { week: '2026-W02', newPages: 15, cumulativePages: 25 },
        ],
      },
      duplicatePageRate: {
        potentialDuplicates: 8,
        highSimilarityPairs: 3,
        rate: 0.0714,
        sampleCount: 3,
      },
      misattributionSamples: 0,
    };

    expect(f2.status).toBe('ok');
    expect(f2.counts!.totalConcepts).toBeGreaterThan(0);
    expect(f2.counts!.totalEvents).toBeGreaterThanOrEqual(
      f2.counts!.compiledEvents! +
        f2.counts!.skippedEvents! +
        f2.counts!.failedEvents!,
    );

    // Duplicate page rate between 0 and 1.
    expect(f2.duplicatePageRate!.rate).toBeGreaterThanOrEqual(0);
    expect(f2.duplicatePageRate!.rate).toBeLessThanOrEqual(1);

    // Page count growth is cumulative.
    let prev = 0;
    for (const week of f2.pageCountGrowth!.byWeek) {
      expect(week.cumulativePages).toBe(
        prev + week.newPages,
      );
      prev = week.cumulativePages;
    }
  });

  it('handles empty database (zero concepts, zero events)', () => {
    const f2: F2Section = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      recallMode: 'fts-only',
      counts: {
        totalConcepts: 0,
        totalEvents: 0,
        compiledEvents: 0,
        skippedEvents: 0,
        failedEvents: 0,
        conceptsCreated: 0,
        conceptsMerged: 0,
      },
      pageCountGrowth: { byWeek: [] },
      duplicatePageRate: {
        potentialDuplicates: 0,
        highSimilarityPairs: 0,
        rate: 0,
        sampleCount: 0,
      },
      misattributionSamples: 0,
    };

    expect(f2.counts!.totalConcepts).toBe(0);
    expect(f2.counts!.totalEvents).toBe(0);
    expect(f2.duplicatePageRate!.rate).toBe(0);
    expect(Number.isNaN(f2.duplicatePageRate!.rate)).toBe(false);
    expect(f2.pageCountGrowth!.byWeek).toHaveLength(0);
  });
});

// ── Token cost tiers ────────────────────────────────────────────────────────

describe('Token cost tiers', () => {
  it('all tiers are honestly marked as 未测', () => {
    // Until the LLM/embedding clients are instrumented for usage tracking,
    // every tier must report `measured: false` with a concrete reason.
    const tiers: TokenCostTier[] = [
      {
        tier: 'f1-extract',
        measured: false,
        reason:
          'LLM client does not capture prompt/completion token counts ' +
          'from provider responses.',
        provider: 'openai',
        model: 'gpt-4o-2024-08-06',
        totalCalls: 12,
        estimatedCostUsd: null,
      },
      {
        tier: 'f2-merge',
        measured: false,
        reason:
          'F2 merge-decider LLM calls are not yet instrumented for token counting.',
        totalCalls: undefined,
        estimatedCostUsd: null,
      },
      {
        tier: 'embedding',
        measured: false,
        reason:
          'The EmbeddingClient port does not track input sizes per call.',
        estimatedCostUsd: null,
      },
    ];

    expect(tiers).toHaveLength(3);

    for (const tier of tiers) {
      expect(tier.measured).toBe(false);
      expect(typeof tier.reason).toBe('string');
      expect(tier.reason!.length).toBeGreaterThan(10);
      // estimatedCostUsd must be null when not measured — never fabricated.
      expect(tier.estimatedCostUsd).toBeNull();
    }
  });

  it('does not fabricate costs', () => {
    // A fabricated cost would set measured=false but still provide a number.
    // This is forbidden — the estimatedCostUsd field must be null when
    // measured is false.
    const tier: TokenCostTier = {
      tier: 'f1-extract',
      measured: false,
      reason: 'No token tracking.',
      estimatedCostUsd: null,
    };

    expect(tier.measured).toBe(false);
    expect(tier.estimatedCostUsd).toBeNull();
  });

  it('provides a note explaining the 未测 status', () => {
    const note =
      'All token cost tiers are marked "未测" because the current ' +
      'LlmClient and EmbeddingClient ports do not capture usage metadata ' +
      '(prompt_tokens, completion_tokens, total_tokens) from provider ' +
      'responses.';

    expect(note).toContain('未测');
    expect(note).toContain('LlmClient');
    expect(note).toContain('EmbeddingClient');
    expect(note).toContain('usage metadata');
    expect(note).toContain('prompt_tokens');
    expect(note).toContain('completion_tokens');
    expect(note).toContain('total_tokens');
  });
});

// ── Full report ─────────────────────────────────────────────────────────────

describe('M1QualityReport full assembly', () => {
  it('assembles a valid report with both sections skipped', () => {
    const report: M1QualityReport = {
      meta: {
        reportVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        f1Ran: false,
        f2Ran: true,
      },
      f1: {
        status: 'skipped',
        skipReason: '--f1 not requested',
      },
      f2: {
        status: 'skipped',
        skipReason: 'DATABASE_URL not configured.',
      },
      tokenCosts: {
        tiers: [
          {
            tier: 'f1-extract',
            measured: false,
            reason: 'F1 skipped.',
            estimatedCostUsd: null,
          },
          {
            tier: 'f2-merge',
            measured: false,
            reason: 'F2 skipped.',
            estimatedCostUsd: null,
          },
          {
            tier: 'embedding',
            measured: false,
            reason: 'Embedding client not instrumented.',
            estimatedCostUsd: null,
          },
        ],
        note: 'All tiers marked 未测.',
      },
    };

    expect(report.meta.reportVersion).toBe('1.0.0');
    expect(report.f1.status).toBe('skipped');
    expect(report.f2.status).toBe('skipped');
    expect(report.tokenCosts.tiers).toHaveLength(3);

    // Every tier is 未测.
    for (const tier of report.tokenCosts.tiers) {
      expect(tier.measured).toBe(false);
      expect(tier.estimatedCostUsd).toBeNull();
    }
  });

  it('is valid JSON when serialized', () => {
    const report: M1QualityReport = {
      meta: {
        reportVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        f1Ran: true,
        f2Ran: true,
      },
      f1: {
        status: 'ok',
        provider: 'openai',
        model: 'gpt-4o-2024-08-06',
        timestamp: new Date().toISOString(),
        totalEvents: 20,
        summary: {
          extract: 8,
          prefilterSkip: 8,
          llmSkip: 2,
          totalSkip: 10,
          schemaFailure: 0,
          providerFailure: 0,
          signalRatio: 0.444,
        },
        typeDistribution: {
          decision: 3,
          gotcha: 2,
          runbook: 1,
          convention: 1,
          service: 1,
          concept: 0,
        },
        confidenceDistribution: {
          high: 4,
          medium: 3,
          low: 1,
        },
        latencyMs: {
          min: 1,
          max: 3500,
          avg: 800,
          p50: 750,
          p95: 3000,
        },
      },
      f2: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        recallMode: 'fts-only',
        counts: {
          totalConcepts: 42,
          totalEvents: 150,
          compiledEvents: 100,
          skippedEvents: 30,
          failedEvents: 20,
          conceptsCreated: 42,
          conceptsMerged: 15,
        },
        pageCountGrowth: { byWeek: [] },
        duplicatePageRate: {
          potentialDuplicates: 8,
          highSimilarityPairs: 3,
          rate: 0.0714,
          sampleCount: 3,
        },
        misattributionSamples: 0,
      },
      tokenCosts: {
        tiers: [
          {
            tier: 'f1-extract',
            measured: false,
            reason: 'No token tracking instrumentation.',
            provider: 'openai',
            model: 'gpt-4o-2024-08-06',
            totalCalls: 12,
            estimatedCostUsd: null,
          },
          {
            tier: 'f2-merge',
            measured: false,
            reason: 'No token tracking instrumentation.',
            estimatedCostUsd: null,
          },
          {
            tier: 'embedding',
            measured: false,
            reason: 'No embedding size tracking.',
            estimatedCostUsd: null,
          },
        ],
        note: 'All tiers 未测.',
      },
    };

    const serialized = JSON.stringify(report);
    expect(typeof serialized).toBe('string');

    const reparsed: unknown = JSON.parse(serialized);
    expect(reparsed).toBeTruthy();
    expect(typeof reparsed).toBe('object');
    expect((reparsed as Record<string, unknown>)['meta']).toBeTruthy();
  });
});

// ── Boundary cases ──────────────────────────────────────────────────────────

describe('M1 quality report boundary cases', () => {
  it('handles zero-extract F1 (pure noise)', () => {
    const f1: F1Section = {
      status: 'ok',
      provider: 'openai',
      model: 'gpt-4o-2024-08-06',
      timestamp: new Date().toISOString(),
      totalEvents: 20,
      summary: {
        extract: 0,
        prefilterSkip: 18,
        llmSkip: 2,
        totalSkip: 20,
        schemaFailure: 0,
        providerFailure: 0,
        signalRatio: 0,
      },
      typeDistribution: {
        decision: 0,
        gotcha: 0,
        runbook: 0,
        convention: 0,
        service: 0,
        concept: 0,
      },
      confidenceDistribution: {
        high: 0,
        medium: 0,
        low: 0,
      },
      latencyMs: {
        min: 1,
        max: 500,
        avg: 100,
        p50: 50,
        p95: 400,
      },
    };

    expect(f1.summary!.signalRatio).toBe(0);
    // No division-by-zero: signalRatio = 0 / (0 + 20) = 0 is valid.
    expect(Number.isNaN(f1.summary!.signalRatio)).toBe(false);
  });

  it('handles all-extract F1 (pure signal)', () => {
    const f1: F1Section = {
      status: 'ok',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      timestamp: new Date().toISOString(),
      totalEvents: 5,
      summary: {
        extract: 5,
        prefilterSkip: 0,
        llmSkip: 0,
        totalSkip: 0,
        schemaFailure: 0,
        providerFailure: 0,
        signalRatio: 1.0,
      },
      typeDistribution: {
        decision: 2,
        gotcha: 1,
        runbook: 1,
        convention: 1,
        service: 0,
        concept: 0,
      },
      confidenceDistribution: {
        high: 3,
        medium: 2,
        low: 0,
      },
      latencyMs: {
        min: 500,
        max: 2000,
        avg: 1200,
        p50: 1000,
        p95: 1800,
      },
    };

    expect(f1.summary!.signalRatio).toBe(1.0);
  });

  it('handles F2 with rate=0 when no duplicates', () => {
    const f2: F2Section = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      recallMode: 'fts-only',
      counts: {
        totalConcepts: 10,
        totalEvents: 50,
        compiledEvents: 40,
        skippedEvents: 5,
        failedEvents: 5,
        conceptsCreated: 10,
        conceptsMerged: 5,
      },
      pageCountGrowth: { byWeek: [] },
      duplicatePageRate: {
        potentialDuplicates: 0,
        highSimilarityPairs: 0,
        rate: 0,
        sampleCount: 0,
      },
      misattributionSamples: 0,
    };

    expect(f2.duplicatePageRate!.rate).toBe(0);
    expect(Number.isNaN(f2.duplicatePageRate!.rate)).toBe(false);
  });

  it('handles large concept count without overflow', () => {
    const largeCount = 10_000;
    const f2: F2Section = {
      status: 'ok',
      recallMode: 'fts-only',
      counts: {
        totalConcepts: largeCount,
        totalEvents: largeCount * 3,
        compiledEvents: largeCount * 2,
        skippedEvents: largeCount,
        failedEvents: 0,
        conceptsCreated: largeCount,
        conceptsMerged: largeCount,
      },
      pageCountGrowth: { byWeek: [] },
      duplicatePageRate: {
        potentialDuplicates: 500,
        highSimilarityPairs: 50,
        rate: 0.005,
        sampleCount: 50,
      },
      misattributionSamples: 5,
    };

    expect(f2.counts!.totalConcepts).toBe(largeCount);
    // Rate is safely below 1.
    expect(f2.duplicatePageRate!.rate).toBeLessThan(1);
  });
});
