/**
 * Search request/response DTOs. (Contract v0.3 — M1, Q9: text/semantic search
 * via POST /v1/search, never mixed into the concepts list API.)
 */
import { z } from 'zod';
import {
  confidence,
  conceptPath,
  conceptStatus,
  conceptType,
} from './concept.js';
import {
  conceptUuid,
  isoDateTime,
  listLimit,
  projectId,
  requestId,
} from './common.js';

// ── Search request (POST /v1/search) ────────────────────────────────────────
export const searchRequest = z.strictObject({
  projectId,
  query: z.string().min(1).max(500),
  type: conceptType.optional(),
  status: conceptStatus.optional(),
  cursor: z.string().optional(),
  limit: listLimit,
});
export type SearchRequest = z.infer<typeof searchRequest>;

// ── Search result item — concept summary + relevance + FTS degradation ─────
export const searchResult = z.strictObject({
  uuid: conceptUuid,
  path: conceptPath,
  type: conceptType,
  status: conceptStatus,
  confidence,
  title: z.string().min(1),
  tags: z.array(z.string()),
  lastConfirmed: isoDateTime,
  /** Relevance score [0, 1] — higher is more relevant. */
  relevance: z.number().min(0).max(1),
  /** True when this result was produced by FTS rather than semantic vector search. */
  ftsFallback: z.boolean(),
});
export type SearchResult = z.infer<typeof searchResult>;

// ── Search response ─────────────────────────────────────────────────────────
export const searchResponse = z.strictObject({
  requestId,
  results: z.array(searchResult),
  /** True when semantic search was unavailable and the entire query fell back to FTS. */
  degraded: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type SearchResponse = z.infer<typeof searchResponse>;
