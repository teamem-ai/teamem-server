#!/usr/bin/env -S npx tsx
/**
 * F2 Merge Quality Metric Script (M1-F2-06).
 *
 * Analyses real concept pages and compilation results in the database to
 * compute F2 merge-quality metrics:
 *   1. Wrong-attribution rate — how often F2 merged a concept into the wrong
 *      existing page (requires LLM re-evaluation).
 *   2. Duplicate-page rate — how often F2 created a new page when it should
 *      have merged into an existing one (detected via candidate-recall
 *      similarity, optionally validated by the LLM merge-decider).
 *   3. Page-count growth curve — concept page count over time, before vs
 *      after compilation batches.
 *
 * Red lines:
 *   - Every query carries team_id + project_id (§5.5).
 *   - LLM calls use provider-native structured output with mandatory Zod
 *     re-validation (§5.2).
 *   - No fixtures, no hard-coded results — every metric is computed from
 *     real database rows.
 *   - When no LLM provider is configured, the script reports an honest
 *     degradation to similarity-only heuristics instead of pretending to
 *     have AI-powered analysis.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   TEAMEM_QUALITY_TEAM_ID=team_default \
 *   TEAMEM_QUALITY_PROJECT_ID=prj_default \
 *   [TEAMEM_ANTHROPIC_API_KEY=...] \
 *   npx tsx scripts/m1-f2-quality.ts
 *
 * Output: a machine-readable JSON summary written to stdout.
 */

import { createDb, closeDb, type AppDb } from '../apps/server/src/db/client.js';
import { parseServerEnv } from '../apps/server/src/config/env.js';
import {
  createLlmClient,
  DEFAULT_MODELS,
  type LlmClient,
} from '../apps/server/src/llm/factory.js';
import { createEmbeddingClient } from '../apps/server/src/llm/embedding/factory.js';
import { recallCandidates } from '../apps/server/src/compiler/f2/candidates.js';
import { buildF1Prompt } from '../apps/server/src/compiler/f1/prompt.js';
import { f1Output } from '../apps/server/src/compiler/f1/output.js';
import {
  decideMerge,
  type CandidateConceptSummary,
  type NewConceptInput,
} from '../apps/server/src/compiler/f2/merge-decider.js';
import type { F2Decision } from '../apps/server/src/compiler/f2/decision.js';
import { projectScope } from '../apps/server/src/auth/scope.js';
import { resolveSemanticCapability } from '../apps/server/src/llm/embedding/capability.js';
import type { EmbeddingClient } from '../apps/server/src/llm/embedding/port.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import * as schema from '../apps/server/src/db/schema.js';

// ── Configuration ───────────────────────────────────────────────────────────

export interface QualityConfig {
  databaseUrl: string;
  teamId: string;
  projectId: string;
  /** Maximum concepts to analyse; default 500. */
  maxConcepts: number;
  /** Similarity threshold for flagging potential duplicates (0–1). */
  duplicateSimilarityThreshold: number;
  /**
   * Cap on how many merge decisions are replayed. Each replay costs one F1
   * plus one F2 call, so an unbounded run on a large project would be
   * expensive; merges beyond the cap are counted as unreplayable rather than
   * silently treated as correct.
   */
  maxMisattributionReplays: number;
}

export function parseConfig(): QualityConfig {
  const env = parseServerEnv();

  const teamId = process.env['TEAMEM_QUALITY_TEAM_ID'];
  const projectId = process.env['TEAMEM_QUALITY_PROJECT_ID'];

  if (!teamId) {
    console.error(
      'TEAMEM_QUALITY_TEAM_ID is required (e.g. team_default)',
    );
    process.exit(1);
  }
  if (!projectId) {
    console.error(
      'TEAMEM_QUALITY_PROJECT_ID is required (e.g. prj_default)',
    );
    process.exit(1);
  }

  return {
    databaseUrl: env.databaseUrl,
    teamId,
    projectId,
    maxConcepts: Number(process.env['TEAMEM_QUALITY_MAX_CONCEPTS'] || '500'),
    duplicateSimilarityThreshold: Number(
      process.env['TEAMEM_QUALITY_DUPLICATE_THRESHOLD'] || '0.85',
    ),
    maxMisattributionReplays: Number(
      process.env['TEAMEM_QUALITY_MAX_REPLAYS'] || '50',
    ),
  };
}

// ── Result types ────────────────────────────────────────────────────────────

export interface DuplicateCandidate {
  conceptA: { uuid: string; title: string; path: string };
  conceptB: { uuid: string; title: string; path: string };
  similarity: number;
  recallMode: 'vector' | 'fts';
}

/**
 * One event that F2 merged into a page it arguably should not have.
 *
 * Produced by replaying the decision: F1 is re-run on the original event to
 * reconstruct the candidate concept, candidates are recalled again, and the
 * merge-decider is asked afresh. A sample is emitted only when that replay
 * lands somewhere other than where the recorded compile did.
 */
export interface MisattributionSample {
  /** The event whose attribution is in question. */
  eventId: string;
  externalId: string;
  /**
   * Whether the replay landed on the same page as the recorded compile.
   *
   * Agreement is NOT evidence of correct attribution — the replay asks the
   * same decider the same question, so a systematically biased decider agrees
   * with itself. Every replayed merge is emitted, agreeing or not, precisely
   * so a human has the full list to annotate.
   */
  replayAgreed: boolean;
  /** Where the recorded compile actually put it. */
  recordedTarget: { uuid: string; title: string; path: string };
  /** Where the replay would put it; null means "should have been a new page". */
  replayTarget: { uuid: string; title: string; path: string } | null;
  /** Relationship the replayed decision returned. */
  replayRelationship: string;
  /** Rank of the recorded target in the replayed candidate recall, or null if absent. */
  recordedTargetRank: number | null;
  /** Similarity of the recorded target in the replayed recall, or null if absent. */
  recordedTargetSimilarity: number | null;
  otherCandidates: { uuid: string; title: string; similarity: number }[];
  /** Human annotator can mark as correct/wrong/unclear. */
  annotation?: 'correct' | 'wrong' | 'unclear';
}

/** Token usage accumulated for one cost tier. */
export interface TierUsage {
  measured: boolean;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Accumulates provider-reported usage for one tier. */
class UsageMeter {
  private calls = 0;
  private prompt = 0;
  private completion = 0;
  private total = 0;

  record(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    this.calls++;
    this.prompt += usage.promptTokens;
    this.completion += usage.completionTokens;
    this.total += usage.totalTokens;
  }

  snapshot(): TierUsage {
    return {
      measured: this.calls > 0,
      calls: this.calls,
      promptTokens: this.prompt,
      completionTokens: this.completion,
      totalTokens: this.total,
    };
  }
}

/** Wrong-attribution metric over events that F2 merged into a pre-existing page. */
export interface MisattributionMetrics {
  /** Events that were merged into a page that already existed. */
  mergedEvents: number;
  /** Merges actually replayed — the denominator of `rate`. */
  judged: number;
  /** Merges the replay disagreed with. */
  disagreements: number;
  /** disagreements / mergedEvents; 0 when there were no merges to judge. */
  rate: number;
  /** Merges that could not be replayed (F1 re-extraction failed or skipped). */
  unreplayable: number;
  samples: MisattributionSample[];
}

interface LlmReEvaluation {
  conceptPair: {
    uuidA: string;
    titleA: string;
    uuidB: string;
    titleB: string;
  };
  f2Decision: F2Decision | null;
  error?: string;
}

export interface F2QualityReport {
  meta: {
    generatedAt: string;
    teamId: string;
    projectId: string;
    providerAvailable: boolean;
    providerKind?: string;
    providerModel?: string;
    recallMode: 'vector' | 'fts-only';
  };
  counts: {
    totalConcepts: number;
    totalEvents: number;
    compiledEvents: number;
    skippedEvents: number;
    failedEvents: number;
    conceptsCreated: number;
    conceptsMerged: number;
  };
  pageCountGrowth: {
    /** Concept pages counted by creation week (ISO week). */
    byWeek: { week: string; newPages: number; cumulativePages: number }[];
  };
  duplicatePageRate: {
    /** Total potential duplicate pairs found via similarity. */
    potentialDuplicates: number;
    /** Pairs above the similarity threshold. */
    highSimilarityPairs: number;
    /** Rate = highSimilarityPairs / totalConcepts. */
    rate: number;
    /** Top duplicate candidates for manual review. */
    samples: DuplicateCandidate[];
  };
  misattributionRate: MisattributionMetrics;
  /**
   * Provider-reported token usage observed while producing this report.
   *
   * The replay issues the same F1, F2 and embedding calls a compile does, so
   * these are real per-tier costs rather than an estimate. A tier is
   * `measured: false` when no call in that tier reported usage — absent usage
   * is never recorded as zero cost.
   */
  tokenUsage: {
    f1Extract: TierUsage;
    f2Merge: TierUsage;
    embedding: TierUsage;
  };
  llmReEvaluations: LlmReEvaluation[];
  degradation: {
    providerAvailable: boolean;
    note: string;
  };
}

/** One compiled event and the concept page it actually landed on. */
interface AttributionRecord {
  eventId: string;
  /** The page recorded in job_events.concept_uuids. */
  targetUuid: string;
  compiledAt: Date;
  channel: string;
  kind: string;
  externalId: string;
  payload: Record<string, unknown>;
  /** True when the target page already existed, i.e. this was a merge. */
  isMerge: boolean;
}

// ── Database helpers ────────────────────────────────────────────────────────

interface ConceptRow {
  uuid: string;
  title: string;
  body: string;
  type: string;
  status: string;
  path: string;
  tags: string[];
  createdAt: Date;
}

async function loadConcepts(
  db: AppDb,
  teamId: string,
  projectId: string,
  limit: number,
): Promise<ConceptRow[]> {
  // Drizzle's leftJoin adds the joined columns under a dotted-key namespace.
  // We select the raw rows and extract the path from the joined result.
  const rows = await db
    .select({
      uuid: schema.concepts.uuid,
      title: schema.concepts.title,
      body: schema.concepts.body,
      type: schema.concepts.type,
      status: schema.concepts.status,
      tags: schema.concepts.tags,
      createdAt: schema.concepts.createdAt,
      path: schema.conceptPaths.path,
    })
    .from(schema.concepts)
    .leftJoin(
      schema.conceptPaths,
      and(
        eq(schema.conceptPaths.conceptUuid, schema.concepts.uuid),
        eq(schema.conceptPaths.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(schema.concepts.teamId, teamId),
        eq(schema.concepts.projectId, projectId),
      ),
    )
    .orderBy(desc(schema.concepts.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    uuid: r.uuid,
    title: r.title,
    body: r.body,
    type: r.type,
    status: r.status,
    path: r.path ?? '',
    tags: r.tags,
    createdAt: r.createdAt,
  }));
}

async function loadEventStats(
  db: AppDb,
  teamId: string,
  projectId: string,
): Promise<{
  totalEvents: number;
  compiledEvents: number;
  skippedEvents: number;
  failedEvents: number;
}> {
  const eventCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.teamId, teamId),
        eq(schema.events.projectId, projectId),
      ),
    );
  const totalEvents = eventCount[0]?.count ?? 0;

  const jobEventStats = await db
    .select({
      status: schema.jobEvents.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.jobEvents)
    .where(
      and(
        eq(schema.jobEvents.teamId, teamId),
        eq(schema.jobEvents.projectId, projectId),
      ),
    )
    .groupBy(schema.jobEvents.status);

  let compiledEvents = 0;
  let skippedEvents = 0;
  let failedEvents = 0;
  for (const row of jobEventStats) {
    if (row.status === 'compiled') compiledEvents = row.count;
    else if (row.status === 'skipped') skippedEvents = row.count;
    else if (row.status === 'failed') failedEvents = row.count;
  }

  return { totalEvents, compiledEvents, skippedEvents, failedEvents };
}

async function loadConceptsCreatedAndMerged(
  db: AppDb,
  teamId: string,
  projectId: string,
): Promise<{ conceptsCreated: number; conceptsMerged: number }> {
  const compiled = await db
    .select({
      conceptUuids: schema.jobEvents.conceptUuids,
    })
    .from(schema.jobEvents)
    .where(
      and(
        eq(schema.jobEvents.teamId, teamId),
        eq(schema.jobEvents.projectId, projectId),
        eq(schema.jobEvents.status, 'compiled'),
      ),
    );

  const totalConcepts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.concepts)
    .where(
      and(
        eq(schema.concepts.teamId, teamId),
        eq(schema.concepts.projectId, projectId),
      ),
    );

  const conceptsCreated = totalConcepts[0]?.count ?? 0;
  let conceptsMerged = 0;
  for (const row of compiled) {
    if (row.conceptUuids && row.conceptUuids.length > 0) {
      conceptsMerged += row.conceptUuids.length;
    }
  }
  return { conceptsCreated, conceptsMerged };
}

// ── Page count growth curve ─────────────────────────────────────────────────

async function computePageCountGrowth(
  db: AppDb,
  teamId: string,
  projectId: string,
): Promise<{ week: string; newPages: number; cumulativePages: number }[]> {
  const rows = await db
    .select({
      createdAt: schema.concepts.createdAt,
    })
    .from(schema.concepts)
    .where(
      and(
        eq(schema.concepts.teamId, teamId),
        eq(schema.concepts.projectId, projectId),
      ),
    )
    .orderBy(sql`${schema.concepts.createdAt} ASC`);

  // Group by ISO week.
  const weekMap = new Map<string, number>();
  for (const row of rows) {
    const d = row.createdAt;
    const year = d.getUTCFullYear();
    const jan1 = new Date(Date.UTC(year, 0, 1));
    const dayOfYear =
      Math.floor((d.getTime() - jan1.getTime()) / 86_400_000);
    const weekNum = Math.ceil((dayOfYear + jan1.getUTCDay() + 1) / 7);
    const key = `${year}-W${String(weekNum).padStart(2, '0')}`;
    weekMap.set(key, (weekMap.get(key) ?? 0) + 1);
  }

  let cumulative = 0;
  const result: { week: string; newPages: number; cumulativePages: number }[] = [];
  for (const [week, count] of [...weekMap.entries()].sort()) {
    cumulative += count;
    result.push({ week, newPages: count, cumulativePages: cumulative });
  }

  return result;
}

// ── Duplicate page detection ────────────────────────────────────────────────

/**
 * For each concept, search for similar existing concepts and flag pairs
 * above the similarity threshold as potential duplicates.
 */
async function detectDuplicatePages(
  db: AppDb,
  concepts: ConceptRow[],
  teamId: string,
  projectId: string,
  threshold: number,
  embeddingClient: EmbeddingClient | null,
  capability: { mode: 'vector' | 'fts-only' },
): Promise<{
  potentialDuplicates: number;
  highSimilarityPairs: number;
  rate: number;
  samples: DuplicateCandidate[];
}> {
  const scope = projectScope(teamId, projectId);
  const checkedPairs = new Set<string>();
  const samples: DuplicateCandidate[] = [];
  let potentialDuplicates = 0;
  let highSimilarityPairs = 0;

  for (const concept of concepts) {
    try {
      const results = await recallCandidates(
        { db, embeddingClient, capability },
        {
          scope,
          newConcept: {
            title: concept.title,
            body: concept.body,
          },
          limit: 10,
        },
      );

      for (const result of results) {
        // Avoid double-counting and self-matches.
        if (result.uuid === concept.uuid) continue;
        const pairKey = [concept.uuid, result.uuid].sort().join('|');
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        potentialDuplicates++;

        if (result.similarity >= threshold) {
          highSimilarityPairs++;
          samples.push({
            conceptA: {
              uuid: concept.uuid,
              title: concept.title,
              path: concept.path,
            },
            conceptB: {
              uuid: result.uuid,
              title: result.title,
              path: result.path,
            },
            similarity: result.similarity,
            recallMode: result.mode,
          });
        }
      }
    } catch {
      // Skip concepts where recall fails (e.g. empty body, embedding error).
    }
  }

  // Sort by similarity descending; take top 20.
  samples.sort((a, b) => b.similarity - a.similarity);
  const topSamples = samples.slice(0, 20);

  return {
    potentialDuplicates,
    highSimilarityPairs,
    rate:
      concepts.length > 0
        ? Number((highSimilarityPairs / concepts.length).toFixed(4))
        : 0,
    samples: topSamples,
  };
}

// ── Misattribution analysis ─────────────────────────────────────────────────

/**
 * Load every compiled event together with the concept page it landed on, and
 * mark which of those were merges into a page that already existed.
 *
 * `job_events.concept_uuids` is the record of what F2 actually did — this is
 * what makes wrong-attribution measurable without any contract change. For a
 * page that received several events, the earliest compile created it and the
 * rest were merges; only the merges can be mis-attributed (an event that
 * created its own page is a duplicate-page question, measured separately).
 */
async function loadAttributions(
  db: AppDb,
  teamId: string,
  projectId: string,
): Promise<AttributionRecord[]> {
  const rows = await db
    .select({
      eventId: schema.jobEvents.eventId,
      conceptUuids: schema.jobEvents.conceptUuids,
      updatedAt: schema.jobEvents.updatedAt,
      channel: schema.events.channel,
      kind: schema.events.kind,
      externalId: schema.events.externalId,
      payload: schema.events.payload,
    })
    .from(schema.jobEvents)
    .innerJoin(
      schema.events,
      and(
        eq(schema.events.teamId, schema.jobEvents.teamId),
        eq(schema.events.projectId, schema.jobEvents.projectId),
        eq(schema.events.id, schema.jobEvents.eventId),
      ),
    )
    .where(
      and(
        eq(schema.jobEvents.teamId, teamId),
        eq(schema.jobEvents.projectId, projectId),
        eq(schema.jobEvents.status, 'compiled'),
      ),
    );

  const records: AttributionRecord[] = [];
  for (const row of rows) {
    const targetUuid = row.conceptUuids?.[0];
    if (!targetUuid) continue;
    records.push({
      eventId: row.eventId,
      targetUuid,
      compiledAt: row.updatedAt,
      channel: row.channel,
      kind: row.kind,
      externalId: row.externalId,
      payload: row.payload as Record<string, unknown>,
      isMerge: false,
    });
  }

  // Per target page, the earliest compile created it; later ones merged in.
  const byTarget = new Map<string, AttributionRecord[]>();
  for (const r of records) {
    const list = byTarget.get(r.targetUuid);
    if (list) list.push(r);
    else byTarget.set(r.targetUuid, [r]);
  }
  for (const list of byTarget.values()) {
    list.sort((a, b) => a.compiledAt.getTime() - b.compiledAt.getTime());
    for (const r of list.slice(1)) r.isMerge = true;
  }

  return records;
}

/**
 * Measure the wrong-attribution rate by replaying each merge decision.
 *
 * For every event that F2 merged into a pre-existing page:
 *   1. Re-run F1 on the original event payload to reconstruct the candidate
 *      concept the decision was made from. F1 output is not persisted, so this
 *      is the only faithful way to rebuild the decider's input — reusing the
 *      merged page's current text instead would bias the replay toward the
 *      recorded answer.
 *   2. Recall candidates again through the same retrieval path.
 *   3. Ask the merge-decider afresh.
 *
 * Every replayed merge is emitted as a sample carrying both targets and the
 * candidate ranking, with `replayAgreed` recording whether the replay matched.
 * Emitting only disagreements would hide the case that matters most: a decider
 * that is consistently wrong agrees with itself every time and would produce
 * an empty list. The `rate` counts disagreements, but the annotation list is
 * complete — the replay is a sampling mechanism, not a verdict.
 *
 * Without an LLM there is nothing to replay: the function reports zero merges
 * judged and an honest `unreplayable` count rather than substituting a
 * similarity heuristic, which cannot see a wrong merge at all (a wrong merge
 * produces one page, not two similar ones).
 */
async function detectMisattributions(
  db: AppDb,
  teamId: string,
  projectId: string,
  embeddingClient: EmbeddingClient | null,
  capability: { mode: 'vector' | 'fts-only' },
  llm: LlmClient | null,
  maxReplays: number,
  f1Meter: UsageMeter,
  f2Meter: UsageMeter,
): Promise<MisattributionMetrics> {
  const scope = projectScope(teamId, projectId);
  const attributions = await loadAttributions(db, teamId, projectId);
  const merges = attributions.filter((a) => a.isMerge);

  const empty: MisattributionMetrics = {
    mergedEvents: merges.length,
    judged: 0,
    disagreements: 0,
    rate: 0,
    unreplayable: merges.length,
    samples: [],
  };

  if (!llm || merges.length === 0) return empty;

  const samples: MisattributionSample[] = [];
  let unreplayable = 0;
  let judged = 0;
  let disagreements = 0;

  for (const merge of merges.slice(0, maxReplays)) {
    try {
      // 1. Rebuild the F1 candidate concept from the original event.
      const { system, user } = buildF1Prompt({
        channel: merge.channel,
        kind: merge.kind,
        externalId: merge.externalId,
        payload: merge.payload,
      });
      const f1 = await llm.structured({
        schema: f1Output,
        systemPrompt: system,
        userPrompt: user,
        requestId: `quality-f1:${merge.eventId}`,
      });
      if (f1.usage) f1Meter.record(f1.usage);
      if (f1.output.action !== 'extract') {
        // The replay would not have produced a concept at all; that is a
        // different failure mode than a wrong target, so do not count it.
        unreplayable++;
        continue;
      }

      const newConcept: NewConceptInput = {
        type: f1.output.type,
        title: f1.output.title,
        body: f1.output.body,
        path: f1.output.path,
        tags: f1.output.tags,
        confidence: f1.output.confidence,
        channel: merge.channel,
        kind: merge.kind,
        externalId: merge.externalId,
      };

      // 2. Recall candidates through the same retrieval path.
      const recalled = await recallCandidates(
        { db, embeddingClient, capability },
        {
          scope,
          newConcept: { title: newConcept.title, body: newConcept.body },
          limit: 10,
        },
      );
      if (recalled.length === 0) {
        unreplayable++;
        continue;
      }

      const recordedIndex = recalled.findIndex(
        (r) => r.uuid === merge.targetUuid,
      );

      // 3. Ask the decider again.
      const candidates = await loadCandidateSummaries(
        db,
        teamId,
        projectId,
        recalled.map((r) => r.uuid),
      );
      if (candidates.length === 0) {
        unreplayable++;
        continue;
      }

      const decision = await decideMerge(
        { llm, onUsage: (u) => f2Meter.record(u) },
        newConcept,
        candidates,
        `quality-f2:${merge.eventId}`,
      );
      judged++;

      const replayTargetUuid =
        decision.relationship === 'unrelated' ? null : decision.targetConceptId;

      const agreed = replayTargetUuid === merge.targetUuid;

      const recorded = await loadConceptSummary(
        db,
        teamId,
        projectId,
        merge.targetUuid,
      );
      const replay = replayTargetUuid
        ? await loadConceptSummary(db, teamId, projectId, replayTargetUuid)
        : null;
      if (!recorded) {
        unreplayable++;
        continue;
      }

      if (!agreed) disagreements++;

      samples.push({
        eventId: merge.eventId,
        externalId: merge.externalId,
        replayAgreed: agreed,
        recordedTarget: recorded,
        replayTarget: replay,
        replayRelationship: decision.relationship,
        recordedTargetRank: recordedIndex >= 0 ? recordedIndex + 1 : null,
        recordedTargetSimilarity:
          recordedIndex >= 0 ? recalled[recordedIndex]!.similarity : null,
        otherCandidates: recalled
          .filter((r) => r.uuid !== merge.targetUuid)
          .slice(0, 5)
          .map((r) => ({ uuid: r.uuid, title: r.title, similarity: r.similarity })),
      });
    } catch (err) {
      // A replay failure is not evidence of correct attribution.
      console.error(
        `[m1-f2-quality] replay failed for event ${merge.eventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      unreplayable++;
    }
  }

  unreplayable += Math.max(0, merges.length - maxReplays);

  return {
    mergedEvents: merges.length,
    judged,
    disagreements,
    // Denominator is merges actually replayed. Counting an unreplayable merge
    // as correctly attributed would report a better rate than was measured.
    rate: judged > 0 ? disagreements / judged : 0,
    unreplayable,
    samples,
  };
}

/** Load the fields the merge-decider needs for a set of candidate uuids. */
async function loadCandidateSummaries(
  db: AppDb,
  teamId: string,
  projectId: string,
  uuids: string[],
): Promise<CandidateConceptSummary[]> {
  const summaries: CandidateConceptSummary[] = [];
  for (const uuid of uuids) {
    const summary = await loadCandidateSummary(db, teamId, projectId, uuid);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

async function loadCandidateSummary(
  db: AppDb,
  teamId: string,
  projectId: string,
  uuid: string,
): Promise<CandidateConceptSummary | null> {
  const rows = await db
    .select({
      uuid: schema.concepts.uuid,
      type: schema.concepts.type,
      status: schema.concepts.status,
      title: schema.concepts.title,
      body: schema.concepts.body,
      tags: schema.concepts.tags,
      path: schema.conceptPaths.path,
    })
    .from(schema.concepts)
    .leftJoin(
      schema.conceptPaths,
      and(
        eq(schema.conceptPaths.conceptUuid, schema.concepts.uuid),
        eq(schema.conceptPaths.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(schema.concepts.teamId, teamId),
        eq(schema.concepts.projectId, projectId),
        eq(schema.concepts.uuid, uuid),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // The merge-decider prompt includes evidence summaries; sending an empty
  // list would give the replay less context than the original decision had.
  const evidenceRows = await db
    .select({
      kind: schema.conceptEvidence.kind,
      ref: schema.conceptEvidence.ref,
      repo: schema.conceptEvidence.repo,
      commitSha: schema.conceptEvidence.commitSha,
      path: schema.conceptEvidence.path,
    })
    .from(schema.conceptEvidence)
    .where(
      and(
        eq(schema.conceptEvidence.teamId, teamId),
        eq(schema.conceptEvidence.projectId, projectId),
        eq(schema.conceptEvidence.conceptUuid, uuid),
      ),
    );

  return {
    uuid: row.uuid,
    type: row.type,
    status: row.status,
    title: row.title,
    body: row.body,
    path: row.path ?? '',
    tags: row.tags,
    evidenceSummary: evidenceRows.map((ev) =>
      ev.kind === 'repo_file'
        ? `repo_file: ${ev.repo ?? '?'}@${ev.commitSha ?? '?'}/${ev.path ?? '?'}`
        : `${ev.kind}: ${ev.ref ?? '(no ref)'}`,
    ),
  };
}

// ── LLM re-evaluation ──────────────────────────────────────────────────────

/**
 * When an LLM provider is available, re-evaluate the top duplicate pairs
 * using the F2 merge-decider to get a structured judgment.
 */
async function llmReEvaluateDuplicates(
  llm: LlmClient,
  db: AppDb,
  pairs: DuplicateCandidate[],
  teamId: string,
  projectId: string,
): Promise<LlmReEvaluation[]> {
  const evaluations: LlmReEvaluation[] = [];

  for (const pair of pairs.slice(0, 10)) {
    // Load full concept bodies for both concepts.
    const rows = await db
      .select({
        uuid: schema.concepts.uuid,
        type: schema.concepts.type,
        status: schema.concepts.status,
        title: schema.concepts.title,
        body: schema.concepts.body,
        tags: schema.concepts.tags,
      })
      .from(schema.concepts)
      .where(
        and(
          eq(schema.concepts.teamId, teamId),
          eq(schema.concepts.projectId, projectId),
          sql`${schema.concepts.uuid} = ANY(ARRAY[${pair.conceptA.uuid}, ${pair.conceptB.uuid}]::uuid[])`,
        ),
      );

    const conceptA = rows.find((r) => r.uuid === pair.conceptA.uuid);
    const conceptB = rows.find((r) => r.uuid === pair.conceptB.uuid);

    if (!conceptA || !conceptB) continue;

    // Load evidence summaries for conceptB (as the "existing" candidate).
    const evidenceRows = await db
      .select({
        kind: schema.conceptEvidence.kind,
        ref: schema.conceptEvidence.ref,
        repo: schema.conceptEvidence.repo,
        commitSha: schema.conceptEvidence.commitSha,
        path: schema.conceptEvidence.path,
      })
      .from(schema.conceptEvidence)
      .where(
        and(
          eq(schema.conceptEvidence.teamId, teamId),
          eq(schema.conceptEvidence.projectId, projectId),
          eq(schema.conceptEvidence.conceptUuid, conceptB.uuid),
        ),
      )
      .limit(5);

    // Load path for conceptB.
    const pathRows = await db
      .select({ path: schema.conceptPaths.path })
      .from(schema.conceptPaths)
      .where(
        and(
          eq(schema.conceptPaths.teamId, teamId),
          eq(schema.conceptPaths.projectId, projectId),
          eq(schema.conceptPaths.conceptUuid, conceptB.uuid),
          eq(schema.conceptPaths.isCurrent, true),
        ),
      )
      .limit(1);

    const candidateB: CandidateConceptSummary = {
      uuid: conceptB.uuid,
      type: conceptB.type,
      status: conceptB.status,
      title: conceptB.title,
      body: conceptB.body,
      path: pathRows[0]?.path ?? '',
      tags: conceptB.tags,
      evidenceSummary: evidenceRows.map((ev) => {
        if (ev.kind === 'repo_file') {
          return `repo_file: ${ev.repo ?? '?'}@${ev.commitSha ?? '?'}/${ev.path ?? '?'}`;
        }
        return `${ev.kind}: ${ev.ref ?? '(no ref)'}`;
      }),
    };

    const newConceptInput: NewConceptInput = {
      type: conceptA.type,
      title: conceptA.title,
      body: conceptA.body,
      path: pair.conceptA.path,
      tags: conceptA.tags,
      confidence: 'high',
      channel: 'cli',
      kind: 'cli_init',
      externalId: 'm1-f2-quality-script',
    };

    try {
      const decision = await decideMerge(
        { llm },
        newConceptInput,
        [candidateB],
        `m1-f2-quality:${pair.conceptA.uuid}:${pair.conceptB.uuid}`,
      );

      evaluations.push({
        conceptPair: {
          uuidA: pair.conceptA.uuid,
          titleA: pair.conceptA.title,
          uuidB: pair.conceptB.uuid,
          titleB: pair.conceptB.title,
        },
        f2Decision: decision,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown LLM error';
      evaluations.push({
        conceptPair: {
          uuidA: pair.conceptA.uuid,
          titleA: pair.conceptA.title,
          uuidB: pair.conceptB.uuid,
          titleB: pair.conceptB.title,
        },
        f2Decision: null,
        error: message,
      });
    }
  }

  return evaluations;
}

// ── LLM-based misattribution analysis ───────────────────────────────────────

/** Minimal identity of a concept, for reporting which page a decision hit. */
async function loadConceptSummary(
  db: AppDb,
  teamId: string,
  projectId: string,
  uuid: string,
): Promise<{ uuid: string; title: string; path: string } | null> {
  const summary = await loadCandidateSummary(db, teamId, projectId, uuid);
  return summary
    ? { uuid: summary.uuid, title: summary.title, path: summary.path }
    : null;
}

// ── LLM re-evaluation ──────────────────────────────────────────────────────


/**
 * Run the full F2 merge-quality analysis and return the report.
 *
 * Exported so `scripts/m1-quality-report.ts` can consume this analysis rather
 * than maintaining its own copy. Two copies had already drifted: the report's
 * copy still hardcoded `embeddingClient = null` and still derived
 * misattribution from a similarity heuristic that cannot see a wrong merge.
 *
 * The caller owns the process; this function closes the database handle it
 * opens and never calls `process.exit`.
 */
export async function runF2Analysis(
  config: QualityConfig,
): Promise<F2QualityReport> {
  console.error(
    `[m1-f2-quality] Team: ${config.teamId}, Project: ${config.projectId}`,
  );

  // Create database connection.
  const db = createDb(config.databaseUrl, {
    connectionTimeoutMillis: 10_000,
  });

  // 3. Determine LLM availability.
  let llm: LlmClient | null = null;
  let providerKind: string | undefined;
  let providerModel: string | undefined;
  let providerAvailable = false;

  let resolvedProvider: ReturnType<typeof parseServerEnv>['llmProviders'][number] | undefined;

  try {
    const env = parseServerEnv();
    const provider = env.llmProviders[0];
    if (provider) {
      resolvedProvider = provider;
      providerKind = provider.kind;
      // Read the model from the factory's own table rather than repeating it
      // here: a duplicated default silently rots when a provider retires a
      // dated model id.
      providerModel = DEFAULT_MODELS[provider.kind] || undefined;
      llm = createLlmClient(provider, {
        defaultModel: providerModel,
        defaultTimeoutMs: 30_000,
      });
      providerAvailable = true;
      console.error(
        `[m1-f2-quality] LLM provider: ${providerKind} (${providerModel ?? 'default'})`,
      );
    } else {
      console.error(
        '[m1-f2-quality] No LLM provider configured — running similarity-only analysis. ' +
          'Set TEAMEM_ANTHROPIC_API_KEY, TEAMEM_OPENAI_API_KEY, or TEAMEM_OPENROUTER_API_KEY ' +
          'for LLM-powered re-evaluation.',
      );
    }
  } catch (err) {
    console.error(
      `[m1-f2-quality] LLM provider init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error('[m1-f2-quality] Falling back to similarity-only analysis.');
  }

  // 4. Resolve embedding/semantic capability from the SAME provider config the
  //    worker uses, so this report measures the deployment's real recall mode.
  //    Hardcoding null here made `recallMode` permanently `fts-only` and the
  //    duplicate-page rate permanently similarity-only, no matter how the
  //    deployment was configured. `createEmbeddingClient` still returns null
  //    for providers without an embedding API (Claude), which is the honest
  //    degradation this report is supposed to surface rather than assume.
  const f1Meter = new UsageMeter();
  const f2Meter = new UsageMeter();
  const embeddingMeter = new UsageMeter();

  let embeddingClient: EmbeddingClient | null = null;
  if (resolvedProvider) {
    try {
      embeddingClient = createEmbeddingClient(resolvedProvider, {
        onUsage: (u) => embeddingMeter.record(u),
      });
    } catch (err) {
      console.error(
        `[m1-f2-quality] Embedding client init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const capability = resolveSemanticCapability(embeddingClient, {
    log: (message) => console.error(`[m1-f2-quality] ${message}`),
  });

  console.error(`[m1-f2-quality] Recall mode: ${capability.mode}`);

  try {
    // 5. Load data.
    console.error('[m1-f2-quality] Loading concepts...');
    const concepts = await loadConcepts(
      db,
      config.teamId,
      config.projectId,
      config.maxConcepts,
    );
    console.error(`[m1-f2-quality] Loaded ${concepts.length} concepts`);

    console.error('[m1-f2-quality] Loading event stats...');
    const eventStats = await loadEventStats(
      db,
      config.teamId,
      config.projectId,
    );

    console.error('[m1-f2-quality] Loading concept creation/merge stats...');
    const { conceptsCreated, conceptsMerged } =
      await loadConceptsCreatedAndMerged(
        db,
        config.teamId,
        config.projectId,
      );

    // 6. Page count growth curve.
    console.error('[m1-f2-quality] Computing page count growth...');
    const pageCountGrowth = await computePageCountGrowth(
      db,
      config.teamId,
      config.projectId,
    );

    // 7. Duplicate page detection.
    console.error('[m1-f2-quality] Detecting duplicate pages...');
    const duplicateMetrics = await detectDuplicatePages(
      db,
      concepts,
      config.teamId,
      config.projectId,
      config.duplicateSimilarityThreshold,
      embeddingClient,
      capability,
    );
    console.error(
      `[m1-f2-quality] Potential duplicates: ${duplicateMetrics.potentialDuplicates}, ` +
        `High similarity pairs: ${duplicateMetrics.highSimilarityPairs}, ` +
        `Rate: ${duplicateMetrics.rate}`,
    );

    // 8. Wrong-attribution rate, by replaying each recorded merge decision.
    console.error('[m1-f2-quality] Replaying merge decisions...');
    const misattributionRate = await detectMisattributions(
      db,
      config.teamId,
      config.projectId,
      embeddingClient,
      capability,
      llm,
      config.maxMisattributionReplays,
      f1Meter,
      f2Meter,
    );
    console.error(
      `[m1-f2-quality] Merges: ${misattributionRate.mergedEvents}, ` +
        `judged: ${misattributionRate.judged}, ` +
        `disagreements: ${misattributionRate.disagreements}, ` +
        `rate: ${misattributionRate.rate}, ` +
        `unreplayable: ${misattributionRate.unreplayable}`,
    );

    // 9. LLM re-evaluation (if provider available).
    let duplicateReEvals: LlmReEvaluation[] = [];

    if (llm && duplicateMetrics.samples.length > 0) {
      const reEvalCount = Math.min(duplicateMetrics.samples.length, 10);
      console.error(
        `[m1-f2-quality] LLM re-evaluating top ${reEvalCount} duplicate pairs...`,
      );
      duplicateReEvals = await llmReEvaluateDuplicates(
        llm,
        db,
        duplicateMetrics.samples,
        config.teamId,
        config.projectId,
      );
      console.error(
        `[m1-f2-quality] LLM duplicate re-evaluations: ${duplicateReEvals.length}`,
      );
    }

    // 10. Assemble report.
    const report: F2QualityReport = {
      meta: {
        generatedAt: new Date().toISOString(),
        teamId: config.teamId,
        projectId: config.projectId,
        providerAvailable,
        providerKind,
        providerModel,
        recallMode: capability.mode,
      },
      counts: {
        totalConcepts: concepts.length,
        totalEvents: eventStats.totalEvents,
        compiledEvents: eventStats.compiledEvents,
        skippedEvents: eventStats.skippedEvents,
        failedEvents: eventStats.failedEvents,
        conceptsCreated,
        conceptsMerged,
      },
      pageCountGrowth: {
        byWeek: pageCountGrowth,
      },
      duplicatePageRate: {
        potentialDuplicates: duplicateMetrics.potentialDuplicates,
        highSimilarityPairs: duplicateMetrics.highSimilarityPairs,
        rate: duplicateMetrics.rate,
        samples: duplicateMetrics.samples,
      },
      misattributionRate,
      tokenUsage: {
        f1Extract: f1Meter.snapshot(),
        f2Merge: f2Meter.snapshot(),
        embedding: embeddingMeter.snapshot(),
      },
      llmReEvaluations: duplicateReEvals,
      degradation: {
        providerAvailable,
        note: providerAvailable
          ? `LLM-powered analysis active (${providerKind ?? 'unknown'})`
          : 'No LLM provider configured. Duplicate detection uses FTS similarity ' +
            'heuristics only, and the wrong-attribution rate is NOT measured — ' +
            'replaying a merge decision requires F1 and the merge-decider, and a ' +
            'similarity heuristic cannot see a wrong merge at all (a wrong merge ' +
            'produces one page, not two similar ones). Every merge is reported as ' +
            'unreplayable rather than assumed correct. Set a TEAMEM_*_API_KEY env ' +
            'var to enable it.',
      },
    };

    console.error('[m1-f2-quality] Analysis complete.');
    return report;
  } finally {
    await closeDb(db);
  }
}

// ── CLI entry point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error('[m1-f2-quality] Starting F2 merge quality analysis...');
  const report = await runF2Analysis(parseConfig());
  console.log(JSON.stringify(report, null, 2));
}

// Only run as a CLI when invoked directly; importing this module for
// `runF2Analysis` must not start an analysis or exit the process.
const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('m1-f2-quality.ts');

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[m1-f2-quality] Fatal error:', err);
    process.exit(1);
  });
}
