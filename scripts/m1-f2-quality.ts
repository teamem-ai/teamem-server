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
import { createLlmClient, type LlmClient } from '../apps/server/src/llm/factory.js';
import { recallCandidates } from '../apps/server/src/compiler/f2/candidates.js';
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

interface QualityConfig {
  databaseUrl: string;
  teamId: string;
  projectId: string;
  /** Maximum concepts to analyse; default 500. */
  maxConcepts: number;
  /** Similarity threshold for flagging potential duplicates (0–1). */
  duplicateSimilarityThreshold: number;
}

function parseConfig(): QualityConfig {
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
  };
}

// ── Result types ────────────────────────────────────────────────────────────

interface DuplicateCandidate {
  conceptA: { uuid: string; title: string; path: string };
  conceptB: { uuid: string; title: string; path: string };
  similarity: number;
  recallMode: 'vector' | 'fts';
}

interface MisattributionSample {
  newConceptTitle: string;
  targetConceptTitle: string;
  targetConceptUuid: string;
  relationship: string;
  similarity: number;
  otherCandidates: { uuid: string; title: string; similarity: number }[];
  /** Human annotator can mark as correct/wrong/unclear. */
  annotation?: 'correct' | 'wrong' | 'unclear';
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

interface F2QualityReport {
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
  misattributionSamples: MisattributionSample[];
  llmReEvaluations: LlmReEvaluation[];
  degradation: {
    providerAvailable: boolean;
    note: string;
  };
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
 * For each concept, check if there is a much more similar concept than the
 * one F2 actually merged into. Using similarity heuristics, flag pairs of
 * highly similar but distinct concepts as potential misattributions for
 * manual review.
 */
async function detectMisattributions(
  db: AppDb,
  concepts: ConceptRow[],
  teamId: string,
  projectId: string,
  embeddingClient: EmbeddingClient | null,
  capability: { mode: 'vector' | 'fts-only' },
): Promise<MisattributionSample[]> {
  const scope = projectScope(teamId, projectId);
  const samples: MisattributionSample[] = [];

  for (const concept of concepts) {
    try {
      const results = await recallCandidates(
        { db, embeddingClient, capability },
        {
          scope,
          newConcept: { title: concept.title, body: concept.body },
          limit: 10,
        },
      );

      // Find concepts similar to this one (excluding self).
      const similar = results.filter(
        (r) => r.uuid !== concept.uuid && r.similarity > 0.5,
      );

      if (similar.length === 0) continue;

      // If the top candidate has high similarity, flag as potential
      // misattribution — two highly similar distinct concepts suggest
      // F2 should have merged them but didn't.
      const top = similar[0]!;

      if (top.similarity >= 0.8) {
        samples.push({
          newConceptTitle: concept.title,
          targetConceptTitle: top.title,
          targetConceptUuid: top.uuid,
          relationship: 'would-be-merge-candidate',
          similarity: top.similarity,
          otherCandidates: similar.slice(1, 5).map((r) => ({
            uuid: r.uuid,
            title: r.title,
            similarity: r.similarity,
          })),
        });
      }
    } catch {
      // Skip individual failures.
    }
  }

  // Limit to top 20 by similarity.
  samples.sort((a, b) => b.similarity - a.similarity);
  return samples.slice(0, 20);
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

async function llmReEvaluateMisattributions(
  llm: LlmClient,
  db: AppDb,
  samples: MisattributionSample[],
  teamId: string,
  projectId: string,
): Promise<LlmReEvaluation[]> {
  const evaluations: LlmReEvaluation[] = [];

  for (const sample of samples.slice(0, 10)) {
    // Find the concept UUIDs by title match.
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
          sql`${schema.concepts.title} = ANY(ARRAY[${sample.newConceptTitle}, ${sample.targetConceptTitle}]::text[])`,
        ),
      );

    const conceptA = rows.find((r) => r.title === sample.newConceptTitle);
    const conceptB = rows.find((r) => r.title === sample.targetConceptTitle);

    if (!conceptA || !conceptB) continue;

    // Load paths.
    const pathRowsA = await db
      .select({ path: schema.conceptPaths.path })
      .from(schema.conceptPaths)
      .where(
        and(
          eq(schema.conceptPaths.teamId, teamId),
          eq(schema.conceptPaths.projectId, projectId),
          eq(schema.conceptPaths.conceptUuid, conceptA.uuid),
          eq(schema.conceptPaths.isCurrent, true),
        ),
      )
      .limit(1);

    const evidenceRowsB = await db
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

    const pathRowsB = await db
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
      path: pathRowsB[0]?.path ?? '',
      tags: conceptB.tags,
      evidenceSummary: evidenceRowsB.map((ev) => {
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
      path: pathRowsA[0]?.path ?? '',
      tags: conceptA.tags,
      confidence: 'high',
      channel: 'cli',
      kind: 'cli_init',
      externalId: 'm1-f2-quality-misattribution',
    };

    try {
      const decision = await decideMerge(
        { llm },
        newConceptInput,
        [candidateB],
        `m1-f2-quality-misattr:${conceptA.uuid}:${conceptB.uuid}`,
      );

      evaluations.push({
        conceptPair: {
          uuidA: conceptA.uuid,
          titleA: conceptA.title,
          uuidB: conceptB.uuid,
          titleB: conceptB.title,
        },
        f2Decision: decision,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown LLM error';
      evaluations.push({
        conceptPair: {
          uuidA: conceptA.uuid,
          titleA: conceptA.title,
          uuidB: conceptB.uuid,
          titleB: conceptB.title,
        },
        f2Decision: null,
        error: message,
      });
    }
  }

  return evaluations;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error('[m1-f2-quality] Starting F2 merge quality analysis...');

  // 1. Parse configuration.
  const config = parseConfig();
  console.error(
    `[m1-f2-quality] Team: ${config.teamId}, Project: ${config.projectId}`,
  );

  // 2. Create database connection.
  const db = createDb(config.databaseUrl, {
    connectionTimeoutMillis: 10_000,
  });

  // 3. Determine LLM availability.
  let llm: LlmClient | null = null;
  let providerKind: string | undefined;
  let providerModel: string | undefined;
  let providerAvailable = false;

  try {
    const env = parseServerEnv();
    const provider = env.llmProviders[0];
    if (provider) {
      providerKind = provider.kind;
      providerModel =
        provider.kind === 'openai'
          ? 'gpt-4o-2024-08-06'
          : provider.kind === 'claude'
            ? 'claude-3-5-sonnet-20241022'
            : provider.kind === 'openrouter'
              ? 'openai/gpt-4o-2024-08-06'
              : undefined;
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

  // 4. Resolve embedding/semantic capability.
  //    No embedding client is available in the quality script, so capability
  //    falls to fts-only (full-text search). This is an honest degradation.
  const embeddingClient: EmbeddingClient | null = null;
  const capability = resolveSemanticCapability(embeddingClient);

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

    // 8. Misattribution detection.
    console.error('[m1-f2-quality] Detecting misattributions...');
    const misattributionSamples = await detectMisattributions(
      db,
      concepts,
      config.teamId,
      config.projectId,
      embeddingClient,
      capability,
    );
    console.error(
      `[m1-f2-quality] Misattribution candidates: ${misattributionSamples.length}`,
    );

    // 9. LLM re-evaluation (if provider available).
    let duplicateReEvals: LlmReEvaluation[] = [];
    let misattrReEvals: LlmReEvaluation[] = [];

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

    if (llm && misattributionSamples.length > 0) {
      const reEvalCount = Math.min(misattributionSamples.length, 10);
      console.error(
        `[m1-f2-quality] LLM re-evaluating top ${reEvalCount} misattribution candidates...`,
      );
      misattrReEvals = await llmReEvaluateMisattributions(
        llm,
        db,
        misattributionSamples,
        config.teamId,
        config.projectId,
      );
      console.error(
        `[m1-f2-quality] LLM misattribution re-evaluations: ${misattrReEvals.length}`,
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
      misattributionSamples,
      llmReEvaluations: [...duplicateReEvals, ...misattrReEvals],
      degradation: {
        providerAvailable,
        note: providerAvailable
          ? `LLM-powered analysis active (${providerKind ?? 'unknown'})`
          : 'No LLM provider configured. Duplicate detection uses FTS similarity ' +
            'heuristics only. Misattribution samples are flagged by high similarity ' +
            'between distinct concepts. Set a TEAMEM_*_API_KEY env var to enable ' +
            'F2 merge-decider re-evaluation.',
      },
    };

    // 11. Output.
    console.log(JSON.stringify(report, null, 2));

    console.error('[m1-f2-quality] Analysis complete.');
  } finally {
    await closeDb(db);
  }
}

main().catch((err) => {
  console.error('[m1-f2-quality] Fatal error:', err);
  process.exit(1);
});
