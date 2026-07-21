/**
 * @teamem/schema (MIT) — shared contract types for teamem.
 *
 * This package is Contract v0.2 Appendix A in executable form: the Zod
 * schemas ARE the contract text ("the appendix is the code").
 * FROZEN 2026-07-17 after five review rounds; casual edits are still not
 * permitted, but the base is no longer bit-for-bit v0.2 — see
 * CONTRACT_ADDITIVE_CHANGES below for the formal, enumerated v0.3 amendments
 * that have since landed. Status is reported honestly rather than claiming
 * "v0.2-frozen" while diverged (acceptance-review finding, DUA-129).
 *
 * General rule (from contract review): always preserve original facts —
 * raw claims, provenance, and authenticated context are stored separately
 * so resolution can be re-run; never store only a resolved result.
 */
export const CONTRACT_STATUS = 'v0.3-additive' as const;

/**
 * Enumerated, formally-tracked additive amendments since the v0.2 freeze
 * (contract §2: "propose an explicit v0.3 change, enumerate ... impact").
 * Each entry is additive-only: no field removed, no existing value's meaning
 * changed, no HTTP-visible behavior altered for pre-existing built-in
 * channels/providers. `impact` enumerates every surface named in §2
 * ("database, API, compiler, UI, MCP, CLI, export, and external
 * compatibility impact") even where the honest answer is "none yet" — M0
 * has no HTTP routes wired to these DTOs, so today's impact is limited to
 * the schema package itself and its direct TypeScript consumers.
 */
export const CONTRACT_ADDITIVE_CHANGES = [
  {
    change: 'DUA-129: generic connector persistence seam',
    summary:
      "source.channel gains 'external' and source.kind gains 'external_event' " +
      '(the generic bucket for any connector outside github/cli/mcp); ' +
      'source gains an optional connectorKind field, enforced (not just ' +
      "documented) to be present iff channel='external'; actor.provider " +
      "widens from a closed enum (['github']) to an open non-empty string, " +
      "matching the connector producer contract's already-open " +
      'NormalizedActor.provider and the general rule that a raw actor claim ' +
      'is preserved verbatim.',
    impact: {
      database:
        'apps/server/src/db/schema.ts: source_channel/source_kind/identity_provider ' +
        'pgEnums gain matching values; events.connector_kind and ' +
        'principals.provider_kind (both NOT NULL) added via a backfilling ' +
        'migration (0001) safe on non-empty tables.',
      api: 'No HTTP routes exist yet in M0 (apps/server/src/index.ts is still a ' +
        'stub) — no live endpoint response shape changes today. When the ' +
        'event list/detail endpoints are built, GET responses can now ' +
        "surface channel='external' with a real actor.provider; existing " +
        "github/cli/mcp responses are byte-for-byte unaffected.",
      cli: 'None. The CLI (teamem-ai/cli, M1) only ever submits cli_init on the ' +
        "restricted sourceInput shape, which this change does not touch.",
      mcp: 'None yet — the MCP endpoint is not implemented in this repo.',
      ui: 'None — apps/web does not consume these DTOs yet.',
      compiler:
        'None — F1/F2 (M1) are not implemented; when built, they will see ' +
        "channel='external' events and must treat them as first-class input, " +
        'not skip them.',
      export: 'None — OKF export is an M3 concern and does not touch source/actor.',
      externalTsConsumers:
        "BREAKING for TypeScript narrowing only, not for valid runtime data: " +
        "actor.provider's inferred type widens from the literal union " +
        "'github' to string. Code that exhaustively switches on " +
        "Actor['provider'] (e.g. a `switch` with no default relying on " +
        "TS narrowing to catch new values at compile time) will still " +
        "compile but silently stop being exhaustive — it will not error, it " +
        "will just fall through for any non-'github' provider. External " +
        "consumers pattern-matching that way should add an explicit " +
        "fallback/default arm. No published npm release of @teamem/schema " +
        'exists yet, so no version of this package with the old closed ' +
        'literal has ever shipped externally.',
    },
  },
  {
    change: 'DUA-203: search request/response DTOs',
    summary:
      'New POST /v1/search endpoint DTOs: searchRequest (projectId, query, ' +
      'optional type/status/limit with default 20 max 100) and searchResponse ' +
      '(results as concept summary + relevance score + ftsFallback flag + ' +
      'degraded flag + composite cursor). cursorPayload gains a search/relevance ' +
      'variant for search pagination.',
    impact: {
      database: 'None — search reads existing concepts; no schema changes needed.',
      api: 'No HTTP routes exist yet in M0 (apps/server/src/index.ts is still a ' +
        'stub) — no live endpoint today. When POST /v1/search is built, it will ' +
        'use these DTOs.',
      cli: 'None — the CLI (teamem-ai/cli, M1) does not call this endpoint directly.',
      mcp: 'The MCP search tool (M1) will consume searchResponse when built.',
      ui: 'None — apps/web does not consume these DTOs yet.',
      compiler: 'None — search is a read path; F1/F2 compilation is unaffected.',
      export: 'None — OKF export is an M3 concern.',
      externalTsConsumers:
        'Fully additive: new file, new discriminated-union cursor variant, new ' +
        'export. Existing imports and runtime behavior are unaffected. No ' +
        'published npm release of @teamem/schema exists yet.',
    },
  },
] as const;

export * from './common.js';
export * from './auth.js';
export * from './actor.js';
export * from './source.js';
export * from './concept.js';
export * from './ingest.js';
export * from './event.js';
export * from './job.js';
export * from './audit.js';
export * from './search.js';
