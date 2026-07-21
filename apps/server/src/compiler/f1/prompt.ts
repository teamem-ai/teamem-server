/**
 * F1 prompt template — provider-neutral structured extraction prompt.
 *
 * This prompt is sent to any BYO LLM (Claude, OpenAI, OpenRouter, custom
 * OpenAI-compatible) with structured output enforced via the provider's
 * native mechanism (forced tool use, JSON Schema response format, etc.).
 *
 * The prompt instructs the model to:
 * 1. Analyze an ingested event's payload
 * 2. Decide whether the event contains extractable team knowledge
 * 3. If yes, produce a candidate concept with semantic content only
 * 4. If no, produce a skip with a reason
 *
 * Server-owned facts (UUID, timestamps, evidence, actor, provenance) are
 * NEVER provided in the output — the compiler supplies them after validation.
 */

export interface F1PromptContext {
  /** The event's source channel (github, cli, mcp, external). */
  channel: string;
  /** The event's parsed kind (github_commit, github_pr, etc.). */
  kind: string;
  /** The event's human-readable external reference (e.g. "org/repo#42"). */
  externalId: string;
  /** The redacted, validated event payload (JSON-serializable). */
  payload: Record<string, unknown>;
}

const CONCEPT_TYPE_GUIDANCE = `\
Each concept has exactly one type. Use these definitions:

- **service**: A named running system, API, worker, or infrastructure component.
  Example: "Auth API", "Payment Worker", "Staging Cluster".

- **concept**: A general domain idea, pattern, or term that the team uses.
  Example: "feature flag", "blue-green deployment", "idempotency key".

- **decision**: A choice the team made, including the rationale.
  Example: "We use Postgres over MongoDB for the main datastore".

- **gotcha**: A pitfall, workaround, or non-obvious behavior someone will
  hit. Example: "GitHub webhooks retry for 72h but may arrive out of order".

- **convention**: A team-agreed coding, review, or process standard.
  Example: "All PRs require one approval from a code owner".

- **runbook**: Step-by-step operational instructions for a specific task.
  Example: "How to rotate the database credentials".`;

const OUTPUT_FORMAT = `\
You must respond with a JSON object matching one of these two shapes:

**Extract** (when the event contains team knowledge):
{
  "action": "extract",
  "type": "<one of: service, concept, decision, gotcha, convention, runbook>",
  "title": "<short, descriptive title>",
  "body": "<markdown body explaining the concept — use teamem://concept/<uuid> for internal links>",
  "path": "<lowercase kebab-case path, e.g. decisions/use-postgres>",
  "tags": ["<relevant tag>", ...],
  "confidence": "<one of: high, medium, low>"
}

**Skip** (when the event does not contain extractable knowledge):
{
  "action": "skip",
  "reason": "<brief explanation of why this event was skipped>"
}`;

const SKIP_CRITERIA = `\
## Skip Criteria — When to Skip an Event

Only skip an event when it clearly contains NO reusable team knowledge.
You MUST provide a specific, honest reason — never skip just to save effort.

### Events that SHOULD be skipped (with specific reason):

1. **No decision, constraint, or operational knowledge**
   - The event is purely mechanical with no rationale, trade-off, or context.
   - Example: a typo fix like "fix typo" with no broader context.

2. **Pure mechanical / cosmetic changes**
   - Whitespace-only changes, formatting-only changes, comment typo fixes.
   - Linter/auto-formatter configuration changes with no team convention discussion.
   - Example: "apply prettier formatting" with no discussion of why the config changed.

3. **Automated dependency bumps with no decision context**
   - Dependabot, Renovate, or similar automated version bumps.
   - The bump itself contains no team decision, trade-off analysis, or migration notes.
   - Example: "Bump eslint from 8.57.0 to 8.57.1" with auto-generated body.

4. **Meaningless or placeholder messages**
   - Single-word messages like "asdf", "WIP", "test", "tmp", ".", emoji-only.
   - Messages that carry zero semantic content.
   - Example: commit message "asdf" or "🚀".

5. **Auto-generated merge commits**
   - Git-generated merge commits ("Merge branch 'X' into Y").
   - The merged commits themselves may contain knowledge, but the merge commit is mechanical.

6. **Vague updates with no detail**
   - "update README", "update docs" with no actual content or decision.
   - Version-only tags like "v1.2.3" with no release notes.

### Events that should NOT be skipped:
- Commit messages that explain a rationale, trade-off, or architectural decision.
- PR/issue bodies that discuss conventions, gotchas, or runbooks.
- Any content that a new team member would benefit from knowing.
- Even brief messages if they contain a decision (e.g., "Switch to JWT for auth — simpler than sessions").

### When in doubt:
- If the event is borderline (could go either way), prefer EXTRACT with confidence "low".
- Skipping is for clearly valueless events only — err on the side of extraction.`;

const SERVER_OWNED_FACTS = `\
CRITICAL: The following fields are SERVER-OWNED and must NOT appear in your output:
- uuid, schemaVersion, firstSeen, lastConfirmed, createdAt, updatedAt
- evidence (the server constructs evidence from the event source)
- contributors (the server resolves actors from authentication context)
- supersedes (the server resolves supersession by looking up existing concepts)
- aliases (the server manages path history)
- status (the server sets initial status)

If you include any of these fields, your response will be rejected.`;

/**
 * Build the full F1 prompt for a given event context.
 *
 * The system message sets the role and constraints. The user message provides
 * the event data. This separation is provider-neutral: all major LLM APIs
 * support system/user message roles.
 */
export function buildF1Prompt(ctx: F1PromptContext): {
  system: string;
  user: string;
} {
  const system = `\
You are a knowledge extraction engine for a software team. Your job is to analyze an ingested event and determine whether it contains reusable team knowledge.

${CONCEPT_TYPE_GUIDANCE}

${OUTPUT_FORMAT}

${SKIP_CRITERIA}

${SERVER_OWNED_FACTS}

Rules:
- Only extract knowledge that is clearly supported by the event content.
- Prefer accuracy over completeness: if you are uncertain, use confidence "low" or skip.
- When you skip, your reason must be specific — e.g. "Automated dependency bump with no team decision" not just "no knowledge".
- The body should be self-contained markdown — a new team member should understand it without external context.
- Tags should be lowercase, relevant keywords for discoverability.
- Path segments use lowercase kebab-case (e.g. decisions/use-postgres, conventions/pr-reviews).
- Do not fabricate information not present in the event payload.`;

  const user = `\
Analyze this event and extract a team knowledge concept or skip it.

Event source: ${ctx.channel} (${ctx.kind})
External reference: ${ctx.externalId}

Event payload:
${JSON.stringify(ctx.payload, null, 2)}

Respond with a JSON object matching the extract or skip format.`;

  return { system, user };
}
