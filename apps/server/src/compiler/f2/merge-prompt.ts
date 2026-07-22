/**
 * F2 merge-decision prompt template (M1-F2-03).
 *
 * Constructs the system + user messages sent to the strong model for a
 * merge decision. The prompt:
 *  1. Explains the four possible merge relationships
 *  2. Describes the JSON output format (matching F2-01's f2Decision schema)
 *  3. Lists server-owned fields that must NOT appear
 *  4. Provides the new concept and candidate list for the model to judge
 *
 * Provider-neutral: the same prompt is sent to Claude, OpenAI, OpenRouter,
 * or a custom endpoint. The structured-output mechanism (tool use,
 * json_schema response_format, etc.) is handled by the LlmClient, not here.
 */
import type {
  CandidateConceptSummary,
  NewConceptInput,
} from './merge-decider.js';

// ── Public types ────────────────────────────────────────────────────────────

/** All context needed to build the F2 merge prompt. */
export interface F2MergePromptContext {
  /** The new F1-extracted concept the model must place. */
  readonly newConcept: NewConceptInput;
  /** Existing candidate concepts that might match (may be empty). */
  readonly candidates: readonly CandidateConceptSummary[];
}

// ── Constant prompt sections ────────────────────────────────────────────────

const SYSTEM_ROLE = `\
You are a merge-decision engine for a software team knowledge base. Your job is to analyze a newly extracted concept and decide how it relates to a set of existing candidate concepts. You must choose exactly one of four relationships and produce a merged concept body.`;

const RELATIONSHIP_GUIDANCE = `\
## Merge Relationships

You must select exactly one relationship:

- **confirms**: The new knowledge corroborates an existing concept. The core claim is the same; the evidence is independent and adds weight. The existing concept's status and last_confirmed timestamp should be updated, but the content changes are usually minor (e.g., adding the new evidence reference).

- **extends**: The new knowledge adds meaningful detail to an existing concept without contradicting it. The existing concept body should be rewritten to incorporate the new information while keeping all existing content.

- **contradicts**: The new knowledge conflicts with an existing concept — different technology choice, contradictory claim, incompatible rationale. This is NOT a confidence downgrade. The existing concept's status must become **disputed**. The merged body must present both positions fairly and explain the conflict.

- **unrelated**: The new knowledge does not match any candidate concept. It should become an entirely new concept page. targetConceptId must be null.`;

const OUTPUT_FORMAT = `\
## Output Format

You must respond with a JSON object with exactly these fields:

{
  "relationship": "<confirms | extends | contradicts | unrelated>",
  "targetConceptId": "<UUID of the existing concept, or null for unrelated>",
  "mergedTitle": "<the merged concept title>",
  "mergedBody": "<the complete merged markdown body>",
  "resultStatus": "<active | superseded | disputed | needs-review>"
}

### Rules per relationship:

**confirms**:
- targetConceptId is the existing concept's UUID
- mergedTitle and mergedBody incorporate the new evidence
- resultStatus reflects the existing concept's updated status (usually same as before, or "needs-review" if uncertain)

**extends**:
- targetConceptId is the existing concept's UUID
- mergedTitle and mergedBody incorporate ALL information from both old and new
- resultStatus reflects the updated concept status

**contradicts**:
- targetConceptId is the existing concept's UUID
- mergedBody must present both the original claim AND the contradictory evidence fairly
- resultStatus MUST be "disputed" — no other value is accepted

**unrelated**:
- targetConceptId must be null (the concept is new)
- mergedTitle and mergedBody use the new concept's content as-is (possibly polished)
- resultStatus is "active" (new concepts start active)`;

const SERVER_OWNED_FIELDS = `\
## CRITICAL: Server-Owned Fields

The following fields are SERVER-OWNED and must NOT appear in your output:
- uuid (the concept's canonical identity is generated server-side)
- schemaVersion (the concept format version is server-managed)
- firstSeen, lastConfirmed, createdAt, updatedAt (timestamps are server-managed)
- evidence (the server constructs evidence from source facts)
- contributors (the server resolves actors from authentication context)
- supersedes (the server resolves supersession by looking up existing concepts)
- aliases (the server manages path history)
- path (the server manages path uniqueness and renaming)
- tags (the server may merge tags from multiple sources)
- confidence (the server computes confidence from evidence weight)

If you include any of these fields, your response will be rejected.`;

// ── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Format a candidate concept as human-readable markdown for the prompt.
 */
function formatCandidate(c: CandidateConceptSummary): string {
  const evidence = c.evidenceSummary.length > 0
    ? c.evidenceSummary.map((e) => `  - ${e}`).join('\n')
    : '  (no evidence listed)';

  return `\
### Candidate: ${c.title}
- **UUID**: \`${c.uuid}\`
- **Type**: ${c.type}
- **Status**: ${c.status}
- **Path**: \`${c.path}\`
- **Tags**: ${c.tags.join(', ') || '(none)'}
- **Evidence**:
${evidence}
- **Body**:
${c.body || '(empty)'}`;
}

/**
 * Format the new concept as human-readable markdown for the prompt.
 */
function formatNewConcept(nc: NewConceptInput): string {
  return `\
## New Concept (from ingestion)

- **Type**: ${nc.type}
- **Title**: ${nc.title}
- **Path**: \`${nc.path}\`
- **Tags**: ${nc.tags.join(', ') || '(none)'}
- **Confidence**: ${nc.confidence}
- **Source**: ${nc.channel} / ${nc.kind} (${nc.externalId})
- **Body**:
${nc.body}`;
}

/**
 * Build the F2 merge-decision prompt.
 *
 * The system message sets the role and constraints. The user message provides
 * the new concept and candidate list. This separation follows the same pattern
 * as F1's {@link buildF1Prompt} — system/user role separation is supported by
 * all major LLM APIs.
 */
export function buildF2MergePrompt(ctx: F2MergePromptContext): {
  system: string;
  user: string;
} {
  const system = `\
${SYSTEM_ROLE}

${RELATIONSHIP_GUIDANCE}

${OUTPUT_FORMAT}

${SERVER_OWNED_FIELDS}

## Key Principles

1. Prefer **extends** over **confirms** when the new knowledge adds any detail beyond pure corroboration.
2. Prefer **unrelated** over a forced match — a false merge (assigning knowledge to the wrong concept) poisons trust.
3. Contradictory evidence changes status to **disputed**; it does NOT merely lower confidence. This is a red line.
4. The mergedBody must be self-contained and understandable by a new team member without external context.
5. Do not fabricate information not present in the new concept or candidates.
6. Preserve ALL existing content from the matched candidate in the mergedBody unless the new evidence explicitly supersedes a claim.`;

  const candidatesSection =
    ctx.candidates.length === 0
      ? `\
## Candidate Concepts

**No existing candidates were found.** This new knowledge is likely the first concept of its kind. Use "unrelated" to create a new concept page.`
      : `\
## Candidate Concepts

The following existing concepts may be related to the new knowledge. Consider each one carefully and decide which (if any) the new concept should merge with.

${ctx.candidates.map(formatCandidate).join('\n\n')}`;

  const user = `\
${formatNewConcept(ctx.newConcept)}

${candidatesSection}

## Your Task

Analyze the new concept against each candidate. Decide:
1. Which relationship best describes the match (confirms / extends / contradicts / unrelated)
2. If matching, which candidate UUID to target
3. What the merged title and body should be
4. What the resulting concept status should be (and remember: contradicts → disputed)

Respond with a single JSON object matching the output format above.`;

  return { system, user };
}
