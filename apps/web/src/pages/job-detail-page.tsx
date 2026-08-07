/**
 * Job detail page — D4 in DESIGN.md §10.
 *
 * Shows job metadata, per-event 4-state outcomes (compiled/skipped/failed/pending),
 * and sanitized error with LLM settings action button when no provider is configured.
 * Skipped is neutral (not an error), pending is dashed gray ("not yet processed").
 * Consumes GET /v1/jobs/:id (public HTTP API only).
 */
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  X,
  Minus,
  Clock,
  Copy,
  Terminal,
  Globe,
  PenLine,
  ExternalLink,
  Settings,
  RotateCw,
} from "lucide-react";
import type { Job, JobEventResult, JobStatus } from "@teamem/schema";
import { fetchJobDetail, retryJob, ApiError } from "@/lib/api";
import { useProjectId } from "@/lib/use-project-id";
import { useSession } from "@/lib/session";
import { JobStatusPill } from "@/components/ui/job-status-pill";

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatFullDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(
  startedAt?: string,
  finishedAt?: string,
): string | null {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function initiatedByText(job: Job): string {
  if (job.initiatedBy.kind === "connector") {
    return job.initiatedBy.connector === "github"
      ? "GitHub webhook"
      : job.initiatedBy.connector;
  }
  if (!job.initiatedBy.principalId) {
    return "teamem init";
  }
  return "API key";
}

function initiatedByIcon(job: Job) {
  if (job.initiatedBy.kind === "connector") return Globe;
  if (!job.initiatedBy.principalId) return Terminal;
  return PenLine;
}

// ── Per-event result tag ───────────────────────────────────────────────────

const eventResultConfig = {
  compiled: {
    label: "Compiled",
    icon: Check,
    className: "jr-tag compiled",
  },
  skipped: {
    label: "Skipped",
    icon: Minus,
    className: "jr-tag skipped",
  },
  failed: {
    label: "Failed",
    icon: X,
    className: "jr-tag failed",
  },
  pending: {
    label: "Pending",
    icon: Clock,
    className: "jr-tag pending",
  },
} as const;

function EventResultTag({ result }: { result: JobEventResult }) {
  // result.status is a discriminated union, but TS needs help with the indexing
  const config =
    eventResultConfig[result.status as keyof typeof eventResultConfig];
  const Icon = config.icon;

  let reason = "";
  if (result.status === "skipped" && "reason" in result) {
    reason = ` · ${result.reason}`;
  } else if (result.status === "failed" && "error" in result) {
    reason = ` · ${result.error.code}`;
  }

  return (
    <span className={config.className}>
      <Icon />
      {config.label}
      {reason}
    </span>
  );
}

function skipReasonText(reason: string): string {
  if (reason === "no_knowledge") {
    return "No durable knowledge to keep — this is healthy filtering, not a failure.";
  }
  if (reason === "already_compiled") {
    return "This event was already compiled into knowledge pages.";
  }
  return reason;
}

function EventResultRow({ result }: { result: JobEventResult }) {
  const isCompiled = result.status === "compiled" && "conceptIds" in result;
  const isSkipped = result.status === "skipped";
  const isPending = result.status === "pending";

  return (
    <div className="jr-row">
      <div className="jr-event">
        <code className="mono text-[12px]">{result.eventId}</code>
      </div>
      <div className="jr-result">
        <EventResultTag result={result} />
        {isCompiled && result.conceptIds && result.conceptIds.length > 0 && (
          <div className="text-[12.5px] mt-[6px]">
            →{" "}
            {result.conceptIds.map((cid: string, i: number) => (
              <span key={cid}>
                {i > 0 && ", "}
                <a
                  href={`/concept/${cid}`}
                  className="inline-flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="tbadge concept text-[11px]">
                    <ExternalLink style={{ width: 10, height: 10 }} />
                    Page
                  </span>
                </a>
              </span>
            ))}
          </div>
        )}
        {isSkipped && (
          <div className="text-[12.5px] text-text-3 mt-[6px]">
            {skipReasonText("reason" in result ? result.reason : "")}
          </div>
        )}
        {isPending && (
          <div className="text-[12.5px] text-text-3 mt-[6px]">
            In queue — not processed yet.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { projectId } = useProjectId();
  const { role } = useSession();
  const canRetry = role === "admin" || role === "owner";

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || !projectId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchJobDetail(id, projectId)
      .then((result) => {
        if (cancelled) return;
        setJob(result.data as Job);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Failed to load job detail");
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, projectId]);

  const handleCopyId = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // silent
    }
  };

  const handleRetry = async () => {
    if (!id || !projectId || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await retryJob(id, projectId);
      // Re-fetch so the page reflects the reset (queued) state immediately
      // rather than waiting for the worker to finish and a manual reload.
      const result = await fetchJobDetail(id, projectId);
      setJob(result.data as Job);
    } catch (err) {
      setRetryError(
        err instanceof ApiError ? err.message : "Failed to retry job",
      );
    } finally {
      setRetrying(false);
    }
  };

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="max-w-[860px]">
        <a className="btn btn-ghost btn-sm" href="/jobs" style={{ marginBottom: "14px" }}>
          <ArrowLeft /> Jobs
        </a>
        <div className="card">
          <div className="card-body" style={{ padding: "48px 24px" }}>
            <div className="skeleton h-5 w-[180px] mb-4" />
            <div className="skeleton h-4 w-[300px] mb-2" />
            <div className="skeleton h-4 w-[250px] mb-2" />
            <div className="skeleton h-4 w-[200px]" />
          </div>
        </div>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="max-w-[860px]">
        <a className="btn btn-ghost btn-sm" href="/jobs" style={{ marginBottom: "14px" }}>
          <ArrowLeft /> Jobs
        </a>
        <div className="card">
          <div className="empty-state" style={{ padding: "48px 24px" }}>
            <div className="e-icon" style={{ color: "var(--red)" }}>
              <X />
            </div>
            <h3>Failed to load job</h3>
            <p>{error}</p>
            <div className="e-actions">
              <button
                className="btn btn-outline"
                onClick={() => window.location.reload()}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Not found ─────────────────────────────────────────────────────────────
  if (!job) {
    return (
      <div className="max-w-[860px]">
        <a className="btn btn-ghost btn-sm" href="/jobs" style={{ marginBottom: "14px" }}>
          <ArrowLeft /> Jobs
        </a>
        <div className="card">
          <div className="empty-state" style={{ padding: "48px 24px" }}>
            <div className="e-icon">
              <Clock />
            </div>
            <h3>Not found</h3>
            <p>This job doesn&apos;t exist, or the link is out of date.</p>
          </div>
        </div>
      </div>
    );
  }

  const InitIcon = initiatedByIcon(job);
  const isFailed = job.status === "failed";
  const duration = formatDuration(job.startedAt, job.finishedAt);

  // Count per-event statuses
  const eventResults = job.events ?? [];
  const compiledCount = eventResults.filter((e: JobEventResult) => e.status === "compiled").length;
  const skippedCount = eventResults.filter((e: JobEventResult) => e.status === "skipped").length;
  const failedCount = eventResults.filter((e: JobEventResult) => e.status === "failed").length;
  const pendingCount = eventResults.filter((e: JobEventResult) => e.status === "pending").length;

  // Check if the error is no_llm_provider
  const errorCode = job.error?.code;
  const isNoLlmProvider = errorCode === "no_llm_provider";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-[860px]">
      <a className="btn btn-ghost btn-sm" href="/jobs" style={{ marginBottom: "14px" }}>
        <ArrowLeft /> Jobs
      </a>

      <div className="stack">
        {/* Job metadata card */}
        <div className="card">
          <div className="card-head">
            <span
              className="small muted"
              title="The API does not expose job kind yet (DUA-156 gap)"
            >
              —
            </span>
            <JobStatusPill status={job.status as JobStatus} />
            <div className="ch-actions">
              <button
                className="copy-chip"
                onClick={() => handleCopyId(job.id)}
              >
                {job.id.slice(0, 13)}…
                <Copy />
              </button>
            </div>
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>Initiated by</dt>
              <dd>
                <span className="inline-flex items-center gap-1.5">
                  <InitIcon className="w-[13px] h-[13px]" />
                  <code className="mono text-[12px]">{initiatedByText(job)}</code>
                </span>
              </dd>
              <dt>Created</dt>
              <dd>
                {formatFullDate(job.createdAt)}{" "}
                <span className="text-text-3 text-[12.5px]">
                  ({formatRelativeTime(job.createdAt)})
                </span>
              </dd>
              {duration && (
                <>
                  <dt>Duration</dt>
                  <dd>{duration}</dd>
                </>
              )}
              <dt>Events</dt>
              <dd>
                {job.eventCount} —{" "}
                {compiledCount > 0 && (
                  <span style={{ color: "var(--green)" }}>
                    {compiledCount} compiled
                  </span>
                )}
                {compiledCount > 0 && (skippedCount > 0 || failedCount > 0 || pendingCount > 0) && " · "}
                {skippedCount > 0 && (
                  <span className="text-text-2">{skippedCount} skipped</span>
                )}
                {skippedCount > 0 && (failedCount > 0 || pendingCount > 0) && " · "}
                {failedCount > 0 && (
                  <span style={{ color: "var(--red)" }}>
                    {failedCount} failed
                  </span>
                )}
                {failedCount > 0 && pendingCount > 0 && " · "}
                {pendingCount > 0 && (
                  <span className="text-text-3">{pendingCount} pending</span>
                )}
              </dd>
            </dl>
          </div>
        </div>

        {/* Error card (only for failed jobs) */}
        {isFailed && job.error && (
          <div
            className="card"
            style={isNoLlmProvider ? { borderColor: "var(--red)" } : undefined}
          >
            <div className="card-head">
              <h3 style={isFailed ? { color: "var(--red)" } : undefined}>
                Error
              </h3>
              <div className="ch-actions">
                <code
                  className="mono text-[12px]"
                  style={{ color: "var(--red)" }}
                >
                  {job.error.code}
                </code>
              </div>
            </div>
            <div className="card-body">
              <p className="text-[13.5px] leading-relaxed">
                {job.error.message}
              </p>
              <div className="flex items-center gap-2 mt-[14px]">
                {isNoLlmProvider && (
                  <a
                    className="btn btn-outline btn-sm"
                    href="/settings/llm"
                  >
                    <Settings />
                    Go to LLM settings
                  </a>
                )}
                {canRetry && (
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={handleRetry}
                    disabled={retrying}
                  >
                    <RotateCw />
                    {retrying ? "Retrying…" : "Retry"}
                  </button>
                )}
                <span className="text-[12.5px] text-text-3">
                  {isNoLlmProvider
                    ? "Events are stored safely — they can be re-compiled after adding a provider."
                    : "Re-runs compilation for this job's events."}
                </span>
              </div>
              {retryError && (
                <p
                  className="text-[12.5px] mt-[8px]"
                  style={{ color: "var(--red)" }}
                >
                  {retryError}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Per-event results card */}
        {eventResults.length > 0 && (
          <div className="card">
            <div className="card-head">
              <h3>Per-event results</h3>
            </div>
            <div className="card-body" style={{ paddingTop: "6px" }}>
              {eventResults.map((result: JobEventResult) => (
                <EventResultRow key={result.eventId} result={result} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
