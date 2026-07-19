/**
 * F1 concept page aggregate mapper.
 *
 * Maps a validated F1 extract output + source event facts into a complete
 * concept page aggregate that satisfies the frozen @teamem/schema concept DTO.
 *
 * The LLM provides ONLY semantic content (type, title, body, path, tags,
 * confidence). Every server-owned fact — UUID, timestamps, evidence,
 * contributors, status — is constructed here from source facts that the
 * server already knows. This is the second half of the red line against
 * model fabrication (§5.2): the prompt + strict schema prevent the model
 * from emitting server fields, and this mapper builds them from trusted
 * sources.
 *
 * Design rules:
 * - No evidence → no concept. Returns null rather than fabricating.
 * - `contributors` are candidates with provenance; the repository filters
 *   for `webhook_verified | credential_bound` and drops `client_claimed |
 *   unknown` (Q5/N2).
 * - `firstSeen` and `lastConfirmed` are both set to the event's `occurredAt`
 *   for a brand-new concept (the first evidence IS the confirming evidence).
 * - Status always starts as `active` for M0 (transitions are compiler
 *   business logic, not LLM output).
 * - The concept UUID is generated server-side here so the caller can track
 *   it before persistence.
 */
import { randomUUID } from 'node:crypto';
import type { F1ExtractOutput } from './output.js';
import type {
  CreateConceptInput,
  ConceptEvidenceInput,
  ConceptContributorInput,
} from '../../db/repositories/concepts-write.js';

// ── Input types ─────────────────────────────────────────────────────────────

/**
 * All facts the mapper needs from the ingested event. Every field is either
 * derived by the server (channel, kind, eventId) or preserved from the
 * original source (url, actor, payload, etc.).
 */
export interface ToConceptInput {
  /** Validated F1 extract output — semantic content from the LLM. */
  readonly f1Output: F1ExtractOutput;

  /** Source channel (github, cli, mcp, external). */
  readonly channel: string;
  /** Parsed source kind (github_commit, github_pr, cli_init, etc.). */
  readonly kind: string;
  /** Human-readable external reference (e.g. "org/repo#42"). */
  readonly externalId: string;
  /** Optional URL to the original resource. */
  readonly url?: string | null;
  /** Source-event time. */
  readonly occurredAt: Date;
  /** The ingested event's stable id (evt_...). Used for mcp_write evidence ref. */
  readonly eventId: string;

  /** How the actor claim was obtained (webhook_verified, credential_bound, etc.). */
  readonly actorProvenance: string;
  /** Resolved principal id, if any. */
  readonly actorPrincipalId?: string | null;
  /** Principal that submitted this event (server-derived). */
  readonly ingestedByPrincipalId?: string | null;

  /** Redacted event payload — used to extract repo_file evidence details. */
  readonly payload: Record<string, unknown>;

  /** Tenant scope. */
  readonly teamId: string;
  /** Project scope. */
  readonly projectId: string;
}

// ── Result types ────────────────────────────────────────────────────────────

/**
 * Successful mapping result: the concept input ready for the write repository,
 * plus the server-generated UUID for caller tracking.
 */
export interface ToConceptResult {
  /** The complete concept input (evidence, contributors, metadata). */
  readonly conceptInput: CreateConceptInput;
  /** Server-generated concept UUID (for tracking before persistence). */
  readonly conceptUuid: string;
}

// ── Evidence construction ───────────────────────────────────────────────────

/**
 * Attempt to construct a valid evidence item from source facts.
 *
 * Returns null when the required immutable fields are missing — the frozen
 * evidence discriminated union requires specific fields per kind, and we
 * will not fabricate them.
 */
function buildEvidence(input: ToConceptInput): ConceptEvidenceInput[] | null {
  switch (input.kind) {
    // ── CLI: repo_file evidence ──────────────────────────────────────────
    case 'cli_init': {
      const repo = typeof input.payload['repo'] === 'string' ? input.payload['repo'] : undefined;
      const commitSha = typeof input.payload['commitSha'] === 'string'
        ? input.payload['commitSha']
        : undefined;
      const filePath = typeof input.payload['path'] === 'string' ? input.payload['path'] : undefined;

      if (!repo || !commitSha || !filePath) {
        return null; // Missing immutable repo_file fields — no concept
      }

      // commitSha must match /^[0-9a-f]{7,40}$/ per frozen evidence schema
      if (!/^[0-9a-f]{7,40}$/.test(commitSha)) {
        return null;
      }

      return [
        {
          kind: 'repo_file',
          repo,
          commitSha,
          path: filePath,
          at: input.occurredAt,
        },
      ];
    }

    // ── GitHub commit: URL-based evidence ────────────────────────────────
    case 'github_commit': {
      if (!input.url) return null;
      return [
        {
          kind: 'commit',
          ref: input.url,
          at: input.occurredAt,
        },
      ];
    }

    // ── GitHub PR: URL-based evidence ────────────────────────────────────
    case 'github_pr': {
      if (!input.url) return null;
      return [
        {
          kind: 'pr',
          ref: input.url,
          at: input.occurredAt,
        },
      ];
    }

    // ── GitHub issue: URL-based evidence ─────────────────────────────────
    case 'github_issue': {
      if (!input.url) return null;
      return [
        {
          kind: 'issue',
          ref: input.url,
          at: input.occurredAt,
        },
      ];
    }

    // ── GitHub PR comment: URL-based evidence ────────────────────────────
    case 'github_pr_comment': {
      if (!input.url) return null;
      return [
        {
          kind: 'pr_comment',
          ref: input.url,
          at: input.occurredAt,
        },
      ];
    }

    // ── MCP write: internal reference ────────────────────────────────────
    case 'mcp_write': {
      // Use eventId as the stable internal reference
      return [
        {
          kind: 'mcp_write',
          ref: input.eventId,
          at: input.occurredAt,
        },
      ];
    }

    // ── External / unknown: cannot determine evidence shape ──────────────
    default:
      return null;
  }
}

// ── Contributor construction ────────────────────────────────────────────────

/**
 * Build contributor candidates from the event's actor and ingestion context.
 *
 * Both the actor (if resolved to a principal) and the ingested-by principal
 * are offered as candidates. The write repository filters for trusted
 * provenance (`webhook_verified | credential_bound`) — `client_claimed`
 * and `unknown` are silently dropped (Q5/N2).
 *
 * The actor's provenance applies to the actor principal; ingested-by
 * principals are always `credential_bound` (they come from an authenticated
 * key, which the server resolved).
 */
function buildContributors(
  input: ToConceptInput,
): ConceptContributorInput[] {
  const contributors: ConceptContributorInput[] = [];

  // Actor principal (if resolved) — carries the event's actorProvenance.
  if (input.actorPrincipalId) {
    contributors.push({
      principalId: input.actorPrincipalId,
      provenance: input.actorProvenance as ConceptContributorInput['provenance'],
    });
  }

  // Ingested-by principal — always credential_bound (from an authenticated key).
  if (
    input.ingestedByPrincipalId &&
    input.ingestedByPrincipalId !== input.actorPrincipalId // avoid duplicates
  ) {
    contributors.push({
      principalId: input.ingestedByPrincipalId,
      provenance: 'credential_bound',
    });
  }

  return contributors;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Map a validated F1 extract output + source event facts into a complete
 * concept page aggregate.
 *
 * The returned {@link ToConceptResult.conceptInput} is ready for the concept
 * write repository. The {@link ToConceptResult.conceptUuid} is generated
 * here so the caller can track the concept before persistence (e.g. for
 * job event recording).
 *
 * Returns `null` when evidence cannot be constructed from the available
 * source facts — missing URL, missing immutable repo_file fields, unknown
 * source kind, etc. The caller treats null as a skip: the event contained
 * extractable knowledge but the source facts are insufficient to produce
 * a valid concept page.
 *
 * @returns The complete concept aggregate, or null when evidence is missing.
 */
export function toConcept(input: ToConceptInput): ToConceptResult | null {
  // 1. Construct evidence from source facts.
  //    No evidence → no concept (red line: every page carries evidence).
  const evidence = buildEvidence(input);
  if (!evidence || evidence.length === 0) {
    return null;
  }

  // 2. Build contributor candidates.
  const contributors = buildContributors(input);

  // 3. Generate server-owned UUID.
  const conceptUuid = randomUUID();

  // 4. Assemble the complete concept aggregate.
  const conceptInput: CreateConceptInput = {
    teamId: input.teamId,
    projectId: input.projectId,
    schemaVersion: 1, // CONCEPT_SCHEMA_VERSION
    type: input.f1Output.type,
    status: 'active', // New concepts always start active (M0)
    confidence: input.f1Output.confidence,
    title: input.f1Output.title,
    body: input.f1Output.body,
    tags: input.f1Output.tags,
    firstSeen: input.occurredAt,
    lastConfirmed: input.occurredAt, // First evidence is confirming evidence
    path: input.f1Output.path,
    evidence,
    contributors: contributors.length > 0 ? contributors : undefined,
  };

  return { conceptInput, conceptUuid };
}
