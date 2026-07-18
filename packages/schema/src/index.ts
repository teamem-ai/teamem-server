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
 * channels/providers.
 */
export const CONTRACT_ADDITIVE_CHANGES = [
  {
    change: 'DUA-129: generic connector persistence seam',
    summary:
      "source.channel gains 'external' and source.kind gains 'external_event' " +
      '(the generic bucket for any connector outside github/cli/mcp); ' +
      'source gains an optional connectorKind field (required only when ' +
      "channel='external'); actor.provider widens from a closed enum " +
      "(['github']) to an open non-empty string, matching the connector " +
      'producer contract\'s already-open NormalizedActor.provider and the ' +
      'general rule that a raw actor claim is preserved verbatim.',
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
