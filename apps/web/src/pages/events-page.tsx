/**
 * Events list page — D1 in DESIGN.md §7–§8.
 *
 * Displays ingested events with source badges, actor (Unknown default,
 * webhook_verified ✓), cursor pagination, and source-kind filtering.
 * Consumes GET /v1/events (public HTTP API only).
 */
import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Activity,
  GitCommitHorizontal,
  GitPullRequest,
  CircleDot,
  MessageSquare,
  Terminal,
  Sparkles,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import type { EventSummary, SourceKind, ActorProvenance } from "@teamem/schema";
import { fetchEvents, ApiError } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

// ── Source kind display config ──────────────────────────────────────────────

const sourceKindConfig: Record<
  string,
  { label: string; icon: typeof GitCommitHorizontal; className: string }
> = {
  github_commit: {
    label: "Commit",
    icon: GitCommitHorizontal,
    className: "pill",
  },
  github_pr: {
    label: "Pull request",
    icon: GitPullRequest,
    className: "pill",
  },
  github_issue: {
    label: "Issue",
    icon: CircleDot,
    className: "pill",
  },
  github_pr_comment: {
    label: "PR comment",
    icon: MessageSquare,
    className: "pill",
  },
  cli_init: {
    label: "CLI init",
    icon: Terminal,
    className: "pill",
  },
  mcp_write: {
    label: "MCP write",
    icon: Sparkles,
    className: "pill",
  },
  external_event: {
    label: "External",
    icon: Activity,
    className: "pill",
  },
};

// ── Filter chip definitions ─────────────────────────────────────────────────

const filterChips: { label: string; kind?: SourceKind; icon?: typeof Activity }[] = [
  { label: "All sources" },
  { label: "GitHub", kind: undefined, icon: GitCommitHorizontal },
  { label: "CLI init", kind: "cli_init", icon: Terminal },
  { label: "MCP write", kind: "mcp_write", icon: Sparkles },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Placeholder project ID — will come from scope context in M2-AUTH-03. */
const DEFAULT_PROJECT_ID = "prj_demo00000000000000000000";

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
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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

/** Generate actor initials from displayLogin */
function actorInitials(displayLogin?: string): string {
  if (!displayLogin) return "?";
  return displayLogin.slice(0, 2).toUpperCase();
}

/** Build a human-readable summary from the event source */
function eventSummaryText(event: EventSummary): string {
  const source = event.source;
  switch (source.kind) {
    case "github_commit":
      return source.externalId || "Push";
    case "github_pr":
      return source.externalId || "Pull request";
    case "github_issue":
      return source.externalId || "Issue";
    case "github_pr_comment":
      return source.externalId || "Comment";
    case "cli_init":
    case "mcp_write":
    case "external_event":
      return source.externalId || "";
    default:
      return "";
  }
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SourcePill({ kind }: { kind: string }) {
  const config = sourceKindConfig[kind] ?? {
    label: kind,
    icon: Activity,
    className: "pill",
  };
  const Icon = config.icon;
  return (
    <span className={config.className}>
      <Icon />
      {config.label}
    </span>
  );
}

function ActorCell({
  actor,
  provenance,
}: {
  actor: EventSummary["actor"];
  provenance: ActorProvenance;
}) {
  const isVerified = provenance === "webhook_verified";
  const hasActor = actor !== null;
  const displayLogin = actor?.displayLogin;

  if (!hasActor) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="avatar unknown w-[22px] h-[22px] text-[9px]" aria-label="Unknown actor">
          ?
        </span>
        <span className="text-text-3 text-[13px]">Unknown</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="avatar w-[22px] h-[22px] text-[9px]"
        style={{ background: "var(--emerald)" }}
        aria-label={displayLogin ?? "Actor"}
      >
        {actorInitials(displayLogin)}
      </span>
      <span className="text-[13px]">{displayLogin ?? "Unknown"}</span>
      {isVerified && (
        <ShieldCheck
          className="w-[13px] h-[13px]"
          style={{ color: "var(--green)" }}
          aria-label="webhook_verified"
        />
      )}
    </span>
  );
}

function EventRowSkeleton() {
  return (
    <tr>
      <td>
        <div className="skeleton h-4 w-[70px]" />
      </td>
      <td>
        <div className="flex items-center gap-2">
          <div className="skeleton w-[22px] h-[22px] rounded-full" />
          <div className="skeleton h-3 w-[80px]" />
        </div>
      </td>
      <td>
        <div className="skeleton h-3 w-[200px]" />
      </td>
      <td>
        <div className="skeleton h-3 w-[50px] ml-auto" />
      </td>
    </tr>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export function EventsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>(
    searchParams.get("sourceKind") ?? "",
  );

  // Derive sourceKind filter from state
  const filterKind = activeFilter || undefined;

  // Fetch events
  const loadEvents = useCallback(
    async (cursor?: string, append = false) => {
      if (!append) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      try {
        const result = await fetchEvents({
          projectId: DEFAULT_PROJECT_ID,
          sourceKind: filterKind,
          cursor,
          limit: 20,
        });
        const data = result.data as EventSummary[];
        if (append) {
          setEvents((prev) => [...prev, ...data]);
        } else {
          setEvents(data);
        }
        setNextCursor(result.nextCursor);
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Failed to load events");
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [filterKind],
  );

  // Load on mount and when filter changes
  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Update URL when filter changes
  const handleFilterChange = (kind?: string) => {
    const value = kind ?? "";
    setActiveFilter(value);
    if (value) {
      setSearchParams({ sourceKind: value });
    } else {
      setSearchParams({});
    }
  };

  const handleLoadMore = () => {
    if (nextCursor && !loadingMore) {
      loadEvents(nextCursor, true);
    }
  };

  // ── Render: error state ───────────────────────────────────────────────────
  if (error && events.length === 0) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>Events</h1>
            <p className="sub">
              Raw development activity ingested from GitHub webhooks,{" "}
              <code className="mono">teamem init</code> and agent writes. Events
              are the compiler&apos;s input.
            </p>
          </div>
        </div>
        <div className="card">
          <div className="empty-state" style={{ padding: "48px 24px" }}>
            <div className="e-icon" style={{ color: "var(--red)" }}>
              <Activity />
            </div>
            <h3>Failed to load events</h3>
            <p>{error}</p>
            <div className="e-actions">
              <button
                className="btn btn-outline"
                onClick={() => loadEvents()}
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
          <h1>Events</h1>
          <p className="sub">
            Raw development activity ingested from GitHub webhooks,{" "}
            <code className="mono">teamem init</code> and agent writes. Events
            are the compiler&apos;s input.
          </p>
        </div>
      </div>

      {/* Source filter chips */}
      <div className="filter-row" style={{ marginTop: 0 }}>
        {filterChips.map((chip) => {
          const isActive =
            chip.kind === undefined
              ? activeFilter === ""
              : activeFilter === chip.kind;
          return (
            <button
              key={chip.label}
              className={cn("filter-chip", isActive && "on")}
              onClick={() => handleFilterChange(chip.kind)}
            >
              {chip.icon && <chip.icon />}
              {chip.label}
            </button>
          );
        })}
        <span className="small muted" style={{ marginLeft: "auto" }}>
          {events.length} events · cursor pagination
        </span>
      </div>

      {/* Empty state */}
      {!loading && events.length === 0 && !error && (
        <div className="card">
          <EmptyState
            icon={Activity}
            title="No events ingested yet"
            description="Events arrive from GitHub, teamem init, or agent writes. They are the compiler's raw material."
            actions={
              <a className="btn btn-outline" href="/settings/sources">
                Set up an ingestion source
              </a>
            }
          />
        </div>
      )}

      {/* Events table */}
      {(events.length > 0 || loading) && (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "170px" }}>Source</th>
                <th style={{ width: "210px" }}>Actor</th>
                <th>Summary</th>
                <th style={{ width: "150px" }}>Occurred</th>
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <EventRowSkeleton key={i} />
                  ))
                : events.map((event) => (
                    <tr
                      key={event.id}
                      className="clickable"
                      onClick={() => {
                        window.location.href = `/events/${event.id}?projectId=${DEFAULT_PROJECT_ID}`;
                      }}
                    >
                      <td>
                        <SourcePill kind={event.source.kind} />
                      </td>
                      <td>
                        <ActorCell
                          actor={event.actor}
                          provenance={event.actorProvenance}
                        />
                      </td>
                      <td className="text-text-2 text-[13px]">
                        {eventSummaryText(event)}
                      </td>
                      <td
                        className="text-text-3 text-[12.5px]"
                        title={formatFullDate(event.occurredAt)}
                      >
                        {formatRelativeTime(event.occurredAt)}
                      </td>
                    </tr>
                  ))}
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
