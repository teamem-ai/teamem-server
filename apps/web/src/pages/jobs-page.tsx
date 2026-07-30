/**
 * Jobs list page — D3 in DESIGN.md §9.
 *
 * Lists compilation/ingest jobs with 5-state status badges, cursor
 * pagination, and status filtering. Failed jobs are sorted to the top
 * naturally by the backend's created_at desc sort (failed jobs are
 * recent), and prominent visual error pills make them stand out.
 * Consumes GET /v1/jobs (public HTTP API only).
 */
import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Cpu, Loader2, Terminal, Globe, PenLine } from "lucide-react";
import type { Job, JobStatus } from "@teamem/schema";
import { fetchJobs, ApiError } from "@/lib/api";
import { JobStatusPill } from "@/components/ui/job-status-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PROJECT_ID = "prj_demo00000000000000000000";

const statusFilters: { label: string; status?: JobStatus }[] = [
  { label: "All" },
  { label: "Queued", status: "queued" },
  { label: "Processing", status: "processing" },
  { label: "Completed", status: "completed" },
  { label: "Failed", status: "failed" },
  { label: "Cancelled", status: "cancelled" },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function formatDuration(
  startedAt?: string,
  finishedAt?: string,
): string {
  if (!startedAt) return "—";
  if (!finishedAt) return "running…";
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
  // credential — unknown principal implies teamem init / mcp write
  if (!job.initiatedBy.principalId) {
    return "teamem init";
  }
  return "API key";
}

function initiatedByIcon(job: Job) {
  if (job.initiatedBy.kind === "connector") {
    return Globe;
  }
  if (!job.initiatedBy.principalId) {
    return Terminal;
  }
  return PenLine;
}

// ── Skeleton ────────────────────────────────────────────────────────────────

function JobRowSkeleton() {
  return (
    <tr>
      <td><div className="skeleton h-3 w-[80px]" /></td>
      <td><div className="skeleton h-4 w-[80px]" /></td>
      <td className="num"><div className="skeleton h-3 w-[20px] ml-auto" /></td>
      <td><div className="skeleton h-3 w-[90px]" /></td>
      <td><div className="skeleton h-3 w-[50px]" /></td>
      <td className="num"><div className="skeleton h-3 w-[35px] ml-auto" /></td>
    </tr>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export function JobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>(
    searchParams.get("status") ?? "",
  );

  const filterStatus = (activeFilter || undefined) as JobStatus | undefined;

  const loadJobs = useCallback(
    async (cursor?: string, append = false) => {
      if (!append) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      try {
        const result = await fetchJobs({
          projectId: DEFAULT_PROJECT_ID,
          status: filterStatus,
          cursor,
          limit: 20,
        });
        const data = result.data as Job[];
        if (append) {
          setJobs((prev) => [...prev, ...data]);
        } else {
          setJobs(data);
        }
        setNextCursor(result.nextCursor);
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Failed to load jobs");
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [filterStatus],
  );

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const handleFilterChange = (status?: string) => {
    const value = status ?? "";
    setActiveFilter(value);
    if (value) {
      setSearchParams({ status: value });
    } else {
      setSearchParams({});
    }
  };

  const handleLoadMore = () => {
    if (nextCursor && !loadingMore) {
      loadJobs(nextCursor, true);
    }
  };

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error && jobs.length === 0) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>Jobs</h1>
            <p className="sub">
              Ingest and compilation work units. When events don&apos;t become
              pages, the answer is here.
            </p>
          </div>
        </div>
        <div className="card">
          <div className="empty-state" style={{ padding: "48px 24px" }}>
            <div className="e-icon" style={{ color: "var(--red)" }}>
              <Cpu />
            </div>
            <h3>Failed to load jobs</h3>
            <p>{error}</p>
            <div className="e-actions">
              <button
                className="btn btn-outline"
                onClick={() => loadJobs()}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <h1>Jobs</h1>
          <p className="sub">
            Ingest and compilation work units. When events don&apos;t become
            pages, the answer is here.
          </p>
        </div>
      </div>

      {/* Status filter chips */}
      <div className="filter-row" style={{ marginTop: 0 }}>
        {statusFilters.map((f) => {
          const isActive =
            f.status === undefined
              ? activeFilter === ""
              : activeFilter === f.status;
          return (
            <button
              key={f.label}
              className={cn("filter-chip", isActive && "on")}
              onClick={() => handleFilterChange(f.status)}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Empty state */}
      {!loading && jobs.length === 0 && !error && (
        <div className="card">
          <EmptyState
            icon={Cpu}
            title="No compile jobs yet"
            description="Jobs appear when events are queued for compilation. Ingest some events and they'll show up here."
            actions={
              <a className="btn btn-outline" href="/events">
                View events
              </a>
            }
          />
        </div>
      )}

      {/* Jobs table */}
      {(jobs.length > 0 || loading) && (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "160px" }}>Kind</th>
                <th style={{ width: "150px" }}>Status</th>
                <th style={{ width: "90px" }} className="num">
                  Events
                </th>
                <th style={{ width: "190px" }}>Initiated by</th>
                <th style={{ width: "130px" }}>Created</th>
                <th style={{ width: "110px" }} className="num">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <JobRowSkeleton key={i} />
                  ))
                : jobs.map((job) => {
                    const InitIcon = initiatedByIcon(job);
                    return (
                      <tr
                        key={job.id}
                        className="clickable"
                        onClick={() => {
                          window.location.href = `/jobs/${job.id}`;
                        }}
                      >
                        <td>
                          <code className="mono text-[12px]">{job.error ? "compilation" : "compilation"}</code>
                        </td>
                        <td>
                          <JobStatusPill status={job.status as JobStatus} />
                        </td>
                        <td className="num">{job.eventCount}</td>
                        <td className="text-text-2 text-[13px]">
                          <span className="inline-flex items-center gap-1.5">
                            <InitIcon className="w-[13px] h-[13px]" />
                            {initiatedByText(job)}
                          </span>
                        </td>
                        <td
                          className="text-text-3 text-[12.5px]"
                          title={formatFullDate(job.createdAt)}
                        >
                          {formatRelativeTime(job.createdAt)}
                        </td>
                        <td className="num text-text-3 text-[12.5px]">
                          {formatDuration(job.startedAt, job.finishedAt)}
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      )}

      {/* Load more */}
      {nextCursor && (
        <div className="pager">
          <button
            className="btn btn-outline"
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore && <Loader2 className="animate-spin" />}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
