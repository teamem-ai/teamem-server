/**
 * API client for the teamem portal web UI.
 *
 * Every call goes through the public HTTP API (v1), never importing
 * server internals or connecting to the database directly.
 * The Vite dev server proxies /v1 to the backend; in production the
 * server serves the built SPA and handles API routes on the same origin.
 *
 * Types are manually declared to match @teamem/schema without depending
 * on zod at runtime in the web bundle.
 */

// ── Re-export schema types (runtime-free) ───────────────────────────────────

// These match the @teamem/schema contract exactly.
export type { EventSummary, EventDetail } from "@teamem/schema";
export type { Job, JobEventResult, JobStatus, JobInitiator } from "@teamem/schema";
export type {
  Actor,
  ActorProvenance,
  OccurredAtProvenance,
} from "@teamem/schema";
export type { Source, SourceKind, SourceChannel } from "@teamem/schema";

// ── Query parameter types (match the Zod schemas) ───────────────────────────

export interface EventListParams {
  projectId: string;
  sourceKind?: string;
  cursor?: string;
  limit?: number;
}

export interface JobListParams {
  projectId: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

// ── API response envelopes ──────────────────────────────────────────────────

interface ListEnvelope<T> {
  requestId: string;
  data: T[];
  nextCursor: string | null;
}

interface ItemEnvelope<T> {
  requestId: string;
  data: T;
}

// ── Error handling ──────────────────────────────────────────────────────────

interface ErrorBody {
  requestId?: string;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  code: string;
  status: number;
  requestId?: string;

  constructor(status: number, body: ErrorBody | Record<string, unknown>) {
    const err = body as ErrorBody;
    super(err?.error?.message ?? `API request failed with status ${status}`);
    this.name = "ApiError";
    this.code = err?.error?.code ?? "unknown";
    this.status = status;
    this.requestId = err?.requestId;
  }
}

/**
 * Audit write failed → the server refuses to return the payload.
 * This is the fail-closed lock state on event detail pages.
 */
export class AuditWriteFailedError extends ApiError {
  constructor(status: number, body: ErrorBody | Record<string, unknown>) {
    super(status, body);
    this.name = "AuditWriteFailedError";
  }
}

async function request<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...options,
  });

  if (!res.ok) {
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    // Detect fail-closed audit state: 500 + details.audit_failed === true
    // (backend also preserves the internal message in test/dev configs, but
    // production error handling normalizes the message to "Internal error".)
    const err = body as ErrorBody;
    const isAuditFailed =
      res.status === 500 &&
      (err?.error?.details?.audit_failed === true ||
        err?.error?.details?.audit_failed === "true" ||
        err?.error?.message?.includes("Payload read audit failed"));
    if (isAuditFailed) {
      throw new AuditWriteFailedError(res.status, body);
    }

    throw new ApiError(res.status, body);
  }

  return (await res.json()) as T;
}

// ── Events ──────────────────────────────────────────────────────────────────

export async function fetchEvents(
  params: EventListParams,
): Promise<ListEnvelope<unknown>> {
  const searchParams = new URLSearchParams();
  searchParams.set("projectId", params.projectId);
  if (params.sourceKind) searchParams.set("sourceKind", params.sourceKind);
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.limit) searchParams.set("limit", String(params.limit));

  return request<ListEnvelope<unknown>>(
    `/v1/events?${searchParams.toString()}`,
  );
}

export async function fetchEventDetail(
  eventId: string,
  projectId: string,
): Promise<ItemEnvelope<unknown>> {
  return request<ItemEnvelope<unknown>>(
    `/v1/events/${encodeURIComponent(eventId)}?projectId=${encodeURIComponent(projectId)}`,
  );
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export async function fetchJobs(
  params: JobListParams,
): Promise<ListEnvelope<unknown>> {
  const searchParams = new URLSearchParams();
  searchParams.set("projectId", params.projectId);
  if (params.status) searchParams.set("status", params.status);
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.limit) searchParams.set("limit", String(params.limit));

  return request<ListEnvelope<unknown>>(
    `/v1/jobs?${searchParams.toString()}`,
  );
}

export async function fetchJobDetail(
  jobId: string,
  projectId: string,
): Promise<ItemEnvelope<unknown>> {
  return request<ItemEnvelope<unknown>>(
    `/v1/jobs/${encodeURIComponent(jobId)}?projectId=${encodeURIComponent(projectId)}`,
  );
}
