/**
 * @teamem/schema (MIT) — shared contract types for teamem.
 *
 * Contract v0 (concept page schema, ingestion API, list/query endpoints) is
 * drafted but not yet frozen. Zod schemas and TS types are generated here
 * upon freeze — no speculative types are exported before that, per the
 * project rule against code that only looks finished.
 */
export const CONTRACT_STATUS = 'v0-draft-pending-freeze' as const;
