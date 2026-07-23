# M1 Quality Metrics Report v1

**Report Version:** 1.0.0  
**Task:** DUA-219 (M1-QA-04 — Compile Quality Metrics Report v1)  
**Repository:** `teamem-server`  
**Generated:** See CLI output for latest timestamp  
**Sources:** F1-04 signal-to-noise script, F2-06 merge-quality script  

---

## 1. Overview

This report aggregates quality metrics from the M1 compilation loop pipeline
into a single reference document. Each number is either measured by a real
pipeline run or explicitly marked **未测** with a concrete reason. No metric
is fabricated, hard-coded, or derived from mock data (§5.5).

The three pillars measured are:

| # | Pillar | Source | Measurement |
|---|--------|--------|-------------|
| ① | F1 Signal-to-Noise Ratio | `apps/server/scripts/m1-f1-signal.ts` | Extract/skip counts, type & confidence distributions, latency |
| ③ | F2 Wrong-Attribution & Duplicate-Page Rate | `scripts/m1-f2-quality.ts` | Potential duplicate concept pages, misattribution samples, page-count growth curve |
| ④ | Tiered Token Cost (F1 cheap + F2 strong + embedding) | LlmClient / EmbeddingClient | **未测** — instrumentation not present in current ports |

---

## 2. F1 Signal-to-Noise Ratio (Pillar ①)

### 2.1 Measurement Method

The F1 pipeline is exercised against a diverse set of embedded fixture events
(20 events spanning commits, PRs, issues, comments, and CLI-init docs). Each
event passes through:

1. **Deterministic prefilter** (`skip-filter.ts`): skips obvious noise
   (one-word commits, dependabot bumps, merge commits, version tags, empty
   content, emoji-only messages).
2. **LLM structured extraction** (`output.ts` via `prompt.ts`): provider-native
   structured output (forced tool use for Claude, JSON Schema response_format
   for OpenAI-family), with mandatory Zod re-validation.

Every path is explicit: there is no "approximately correct" fallback.

### 2.2 How to Run

```bash
# Requires a BYO LLM provider (any of: TEAMEM_OPENAI_API_KEY,
# TEAMEM_ANTHROPIC_API_KEY, TEAMEM_OPENROUTER_API_KEY, or
# TEAMEM_OPENAI_COMPAT_BASE_URL + TEAMEM_OPENAI_COMPAT_API_KEY)

pnpm --filter @teamem/server m1:f1-signal
```

Or via the aggregation script:

```bash
TEAMEM_OPENAI_API_KEY=sk-... \
  npx tsx scripts/m1-quality-report.ts --f1
```

### 2.3 Expected Output Structure

```json
{
  "status": "ok",
  "provider": "openai",
  "model": "gpt-4o-2024-08-06",
  "totalEvents": 20,
  "summary": {
    "extract": 8,
    "prefilterSkip": 8,
    "llmSkip": 2,
    "totalSkip": 10,
    "schemaFailure": 0,
    "providerFailure": 0,
    "signalRatio": 0.444
  },
  "typeDistribution": {
    "decision": 3, "gotcha": 2, "runbook": 1,
    "convention": 1, "service": 1, "concept": 0
  },
  "confidenceDistribution": {
    "high": 4, "medium": 3, "low": 1
  },
  "latencyMs": {
    "min": 1, "max": 3500, "avg": 800, "p50": 750, "p95": 3000
  }
}
```

### 2.4 Interpretation

- **Signal Ratio** = `extract / (extract + totalSkip)`. Above 0.3 is
  acceptable for the current prefilter; above 0.5 is good. A ratio near
  0 means the prefilter or LLM is rejecting too many events.
- **Schema Failure** must be 0. Any non-zero value indicates the LLM
  produced output that failed Zod validation — a compilation failure that
  the pipeline routes to review (§5.2).
- **Type Distribution** should show a mix of decision, gotcha, runbook,
  and convention. A single type dominating suggests the fixtures are
  biased or the extraction prompt has a type preference.
- **Confidence Distribution** should skew toward medium and high.
  Dominance of "low" confidence extracts warrants inspection.

### 2.5 Current Results

*Replace with actual CLI output. When no LLM provider is configured, the
report will show `{"status":"skipped","reason":"No BYO LLM provider..."}`.*

| Metric | Value | Notes |
|--------|-------|-------|
| Signal Ratio | *run CLI* | Replace with actual number |
| Extract Count | *run CLI* | Replace with actual number |
| Prefilter Skip | *run CLI* | Replace with actual number |
| LLM Skip | *run CLI* | Replace with actual number |
| Schema Failures | *run CLI* | Replace with actual number |
| Provider Failures | *run CLI* | Replace with actual number |

---

## 3. F2 Duplicate-Page Rate & Misattribution (Pillar ③)

### 3.1 Measurement Method

The F2 quality script (`scripts/m1-f2-quality.ts`) queries the database for:

1. **Concept counts**: total concepts, events, compiled/skipped/failed events,
   concepts created vs merged.
2. **Page-count growth curve**: concept pages created per ISO week.
3. **Duplicate-page detection**: for each concept, candidate search via FTS
   (or vector if embedding is available) to find similar existing concepts.
   Pairs above the similarity threshold are flagged.
4. **Misattribution sampling**: highly similar but distinct concept pairs are
   flagged for manual review.

When an LLM provider is available, the F2 merge-decider re-evaluates the top
duplicate pair candidates. Without a provider, the script degrades to
similarity-only heuristics and honestly reports degradation.

### 3.2 How to Run

```bash
DATABASE_URL=postgres://... \
TEAMEM_QUALITY_TEAM_ID=team_default \
TEAMEM_QUALITY_PROJECT_ID=prj_default \
  npx tsx scripts/m1-f2-quality.ts
```

Or via the aggregation script:

```bash
DATABASE_URL=postgres://... \
TEAMEM_QUALITY_TEAM_ID=team_default \
TEAMEM_QUALITY_PROJECT_ID=prj_default \
  npx tsx scripts/m1-quality-report.ts --f2
```

### 3.3 Expected Output Structure

```json
{
  "meta": {
    "generatedAt": "...",
    "teamId": "team_default",
    "projectId": "prj_default",
    "providerAvailable": false,
    "recallMode": "fts-only"
  },
  "counts": {
    "totalConcepts": 42,
    "totalEvents": 150,
    "compiledEvents": 100,
    "skippedEvents": 30,
    "failedEvents": 20,
    "conceptsCreated": 42,
    "conceptsMerged": 15
  },
  "duplicatePageRate": {
    "potentialDuplicates": 8,
    "highSimilarityPairs": 3,
    "rate": 0.0714,
    "samples": [...]
  }
}
```

### 3.4 Interpretation

- **Duplicate-Page Rate** = `highSimilarityPairs / totalConcepts`. Below 0.05
  (5%) is good; 0.05–0.15 warrants investigation; above 0.15 indicates F2 is
  creating too many separate pages for the same topic.
- **Recall Mode**: `fts-only` means no embedding provider is available; FTS
  similarity is less precise than vector. This is honest degradation (§5.5).
- **Misattribution Samples**: flagged for manual review. A human annotator
  marks each pair as correct, wrong, or unclear. The wrong-assignment rate
  is measured from these annotations.
- **Page-Count Growth**: should show a steady curve. Spikes after compilation
  batches are expected; unexplained spikes without corresponding events may
  indicate duplicates.

### 3.5 Current Results

*Replace with actual CLI output. When `DATABASE_URL` is not configured, the
report will show `{"status":"skipped"}`.*

| Metric | Value | Notes |
|--------|-------|-------|
| Total Concepts | *run CLI* | Replace with actual number |
| Total Events | *run CLI* | Replace with actual number |
| Compiled/Skipped/Failed | *run CLI* | Event stats |
| Duplicate-Page Rate | *run CLI* | Replace with actual number |
| Potential Duplicates | *run CLI* | Replace with actual number |
| High-Similarity Pairs | *run CLI* | Replace with actual number |
| Recall Mode | *run CLI* | vector or fts-only |
| LLM Provider Available | *run CLI* | true or false |

---

## 4. Tiered Token Costs (Pillar ④)

### 4.1 Status: 未测 (Not Measured)

All three token cost tiers are **未测** because the current `LlmClient` and
`EmbeddingClient` ports do not capture usage metadata from provider responses.

### 4.2 Why Token Costs Are Not Tracked

The `LlmClient.structured()` method returns an `LlmResponse<T>` with:

```typescript
interface LlmResponse<T> {
  output: T;             // Zod-validated structured output
  model: ModelMetadata;  // { provider, model, requestId }
}
```

There is no `usage` field. The provider response envelopes from OpenAI
(`usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`)
and Anthropic (`usage.input_tokens`, `usage.output_tokens`) are parsed
for the structured content only — usage data is read but not retained.

### 4.3 What Would Be Required

A backward-compatible extension to `LlmResponse<T>`:

```typescript
interface LlmResponse<T> {
  output: T;
  model: ModelMetadata;
  usage?: {                    // NEW — optional
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

And corresponding extraction in `factory.ts` and `claude-adapter.ts`:

- **OpenAI family**: `response.usage` is already in the HTTP response body;
  extract `usage.prompt_tokens`, `usage.completion_tokens`,
  `usage.total_tokens`.
- **Claude**: `response.usage.input_tokens` and `response.usage.output_tokens`
  are in the Messages API response; map to `promptTokens` and
  `completionTokens`.

For embedding costs, the `EmbeddingClient.generate()` method would need to:
1. Log input character counts (or use tokenizer to estimate).
2. Multiply by `$0.02/1M tokens` (OpenAI text-embedding-3-small).

### 4.4 Known Model Pricing (Reference Only)

These are approximate list prices. **Not used to fabricate costs** — listed
here solely to document the data needed when instrumentation is added.

| Model | Input $/1M tokens | Output $/1M tokens | Notes |
|-------|-------------------|--------------------|-------|
| `gpt-4o-2024-08-06` | $2.50 | $10.00 | F1/F2 default for openai/openrouter |
| `claude-3-5-sonnet-20241022` | $3.00 | $15.00 | F1/F2 default for claude |
| `text-embedding-3-small` | $0.02 | $0.00 | 1536-dimensional embeddings |

### 4.5 Tier Summary

| Tier | Measured | Reason |
|------|----------|--------|
| **F1 Cheap Extraction** | 未测 | `LlmClient` does not retain `usage` from provider responses |
| **F2 Strong Merge-Decider** | 未测 | Same `LlmClient` port limitation as F1 |
| **Embedding** | 未测 | `EmbeddingClient` does not track input sizes per call |

---

## 5. Validation Evidence

### 5.1 Unit Tests

All structural, boundary, and honesty assertions are covered by unit tests:

```bash
npx vitest run scripts/m1-quality-report.test.ts
```

These tests verify:
- Report structure has all required sections
- Token cost tiers are always `measured: false` with concrete reasons
- F1/F2 skip paths are properly structured
- Empty database, zero-extract, and pure-signal boundary cases
- JSON serialization produces valid, re-parseable output
- No fabricated costs (`estimatedCostUsd` is `null` when not measured)

### 5.2 CLI Acceptance

#### Step 1: F1 Signal-to-Noise

```bash
# If LLM provider available:
pnpm --filter @teamem/server m1:f1-signal
# Expected: valid SignalReport JSON with real numbers

# If no LLM provider:
pnpm --filter @teamem/server m1:f1-signal
# Expected: {"status":"skipped","reason":"No BYO LLM provider...","timestamp":"..."}
```

#### Step 2: F2 Merge Quality

```bash
DATABASE_URL=postgres://... \
TEAMEM_QUALITY_TEAM_ID=team_default \
TEAMEM_QUALITY_PROJECT_ID=prj_default \
  npx tsx scripts/m1-f2-quality.ts
# Expected: valid F2QualityReport JSON with real numbers from the database
```

#### Step 3: Aggregated Report

```bash
# F1 only:
TEAMEM_OPENAI_API_KEY=sk-... npx tsx scripts/m1-quality-report.ts --f1

# F2 only:
DATABASE_URL=postgres://... \
TEAMEM_QUALITY_TEAM_ID=team_default \
TEAMEM_QUALITY_PROJECT_ID=prj_default \
  npx tsx scripts/m1-quality-report.ts --f2

# Both:
DATABASE_URL=postgres://... \
TEAMEM_QUALITY_TEAM_ID=team_default \
TEAMEM_QUALITY_PROJECT_ID=prj_default \
TEAMEM_OPENAI_API_KEY=sk-... \
  npx tsx scripts/m1-quality-report.ts --f1 --f2
```

#### Step 4: Full Regression

```bash
pnpm lint
pnpm typecheck
pnpm test
```

---

## 6. Report Completeness Checklist

| Item | Status | Detail |
|------|--------|--------|
| F1 extract/skip ratio | ✅ Script exists | `apps/server/scripts/m1-f1-signal.ts`; run with `m1:f1-signal` |
| F1 type distribution | ✅ In F1-04 output | Decision, gotcha, runbook, convention, service, concept |
| F2 duplicate-page rate | ✅ Script exists | `scripts/m1-f2-quality.ts` |
| F2 misattribution samples | ✅ Script exists | LLM re-evaluation if provider available; FTS fallback otherwise |
| F1 cheap-layer token cost | ⚠️ 未测 | `LlmClient` does not track `usage` |
| F2 strong-layer token cost | ⚠️ 未测 | Same port limitation |
| Embedding token cost | ⚠️ 未测 | `EmbeddingClient` does not track input sizes |
| Per-repo per-week breakdown | ⚠️ 未测 | Concept growth tracked per-week; event repo attribution not instrumented |
| All numbers from real runs | ✅ Verified | Scripts compute from real DB rows / LLM calls; no fixtures in production path |
| Empty/honest states preserved | ✅ Verified | Skip reports explicitly state why; no fabricated data |
| Unit tests | ✅ Created | `scripts/m1-quality-report.test.ts` |

---

## 7. Risk & Next Steps

1. **Token cost instrumentation (M1-F1-07 / M1-F2-07):** The `LlmResponse`
   type needs an optional `usage` field. `factory.ts` and `claude-adapter.ts`
   need to extract `usage` from provider envelopes. This is a
   backward-compatible additive change (new optional field, no breaking API
   change).

2. **Embedding cost tracking:** The `EmbeddingClient.generate()` method should
   log input character counts (or use `tiktoken` for accurate token counts).
   Alternately, the OpenAI embeddings API response includes `usage.total_tokens`
   which could be captured.

3. **Per-repo breakdown:** The concepts table tracks `team_id` and
   `project_id`, but not `repo`. The events table has a `payload` JSONB that
   carries `repo` for `cli_init` events. A future enhancement could join
   concept → event → payload.repo to produce per-repo per-week cost
   breakdowns.

4. **Real LLM provider runs:** The F1 signal-to-noise ratios in section 2.5
   and F2 duplicate-page rates in section 3.5 should be filled in from
   actual CLI runs against a configured environment. Until then, these
   placeholders indicate "run CLI" rather than fabricated numbers.
