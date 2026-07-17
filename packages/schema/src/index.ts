/**
 * @teamem/schema (MIT) — shared contract types for teamem.
 *
 * This package is Contract v0.2 Appendix A in executable form: the Zod
 * schemas ARE the contract text ("the appendix is the code").
 * FROZEN 2026-07-17 after five review rounds — changes from here bump the
 * contract version (v0.3); no casual edits.
 *
 * General rule (from contract review): always preserve original facts —
 * raw claims, provenance, and authenticated context are stored separately
 * so resolution can be re-run; never store only a resolved result.
 */
export const CONTRACT_STATUS = 'v0.2-frozen' as const;

export * from './common.js';
export * from './auth.js';
export * from './actor.js';
export * from './source.js';
export * from './concept.js';
export * from './ingest.js';
export * from './event.js';
export * from './job.js';
export * from './audit.js';
