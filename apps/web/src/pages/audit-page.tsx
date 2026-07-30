import { useState, useEffect, useCallback } from "react";
import { Shield, Copy, ChevronDown, Key } from "lucide-react";
import { EmptyState, PermissionDenied } from "@/components/ui";

// ── Known audit actions (open registry — unknown values rendered as-is) ────

const KNOWN_ACTIONS = [
  "concept.read",
  "event.payload_read",
  "search.query",
  "context.read",
  "compilation.request",
  "event.ingest",
  "audit.query",
  "project.purge",
  "key.create",
  "key.revoke",
  "mcp.search",
  "mcp.timeline",
  "mcp.get_page",
] as const;

// ── Types from @teamem/schema audit DTO ────────────────────────────────────

interface AuditItem {
  id: string;
  createdAt: string;
  requestId: string;
  principalId: string | null;
  credentialId: string | null;
  action: string;
  resourceType: "concept" | "event" | "job" | "audit" | "project" | "key";
  resourceId: string | null;
  teamId: string;
  projectId: string | null;
  outcome: "success" | "denied" | "failed";
}

interface AuditListResponse {
  requestId: string;
  data: AuditItem[];
  nextCursor: string | null;
}

// ── Resource link helpers ──────────────────────────────────────────────────

/** Build a frontend route path for a given resource type and id. */
function resourceLink(type: AuditItem["resourceType"], id: string | null): string | null {
  if (!id) return null;
  switch (type) {
    case "concept":
      return `/concept/${id}`;
    case "event":
      return `/events/${id}`;
    case "job":
      return `/jobs/${id}`;
    default:
      return null;
  }
}

function resourceLabel(type: AuditItem["resourceType"]): string {
  switch (type) {
    case "concept":
      return "concept";
    case "event":
      return "event";
    case "job":
      return "job";
    case "audit":
      return "audit";
    case "project":
      return "project";
    case "key":
      return "key";
  }
}

// ── Time formatting ─────────────────────────────────────────────────────────

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - then;

  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Actor display ───────────────────────────────────────────────────────────

function ActorDisplay({
  principalId,
  credentialId,
}: {
  principalId: string | null;
  credentialId: string | null;
}) {
  // Neither → Unknown
  if (!principalId && !credentialId) {
    return (
      <span className="row gap-2 text-text-3 text-[13px]">
        <span
          className="avatar w-[22px] h-[22px] text-[9px]"
          style={{ background: "var(--zinc)", color: "#fff" }}
        >
          ?
        </span>
        Unknown
      </span>
    );
  }

  // Credential-only → API key or service account
  if (!principalId && credentialId) {
    return (
      <span className="row gap-2">
        <span className="avatar service w-[22px] h-[22px] text-[9px]" style={{ background: "var(--slate)", color: "#fff" }}>
          <Key className="w-[11px] h-[11px]" />
        </span>
        <span className="text-[13px] truncate max-w-[160px]" title={credentialId}>
          {shortId(credentialId)}
        </span>
        <span className="text-[11px] text-text-3">key</span>
      </span>
    );
  }

  // Principal present → human user (or service if labeled elsewhere)
  const displayId = principalId ?? "";
  const initials = displayId.slice(0, 2).toUpperCase().replace(/[^A-Z]/g, "X") || "??";

  return (
    <span className="row gap-2">
      <span
        className="avatar w-[22px] h-[22px] text-[9px] text-white"
        style={{ background: agentColor(displayId) }}
      >
        {initials}
      </span>
      <span className="text-[13px] truncate max-w-[160px]" title={displayId}>
        {displayId.length > 34 ? shortId(displayId) : displayId}
      </span>
    </span>
  );
}

function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function agentColor(seed: string): string {
  const colors = [
    "var(--emerald)",
    "var(--violet)",
    "var(--sky)",
    "var(--rose)",
    "var(--amber)",
    "var(--blue)",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length] ?? colors[0]!;
}

// ── Copy chip ───────────────────────────────────────────────────────────────

function CopyChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard not available — silently ignore
    }
  }, [id]);

  return (
    <button className="copy-chip" onClick={handleCopy} title={`Copy request ID: ${id}`}>
      {copied ? (
        <>
          Copied
          <svg className="w-[12px] h-[12px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </>
      ) : (
        <>
          {shortId(id)}
          <Copy className="w-[12px] h-[12px]" />
        </>
      )}
    </button>
  );
}

// ── Outcome display ─────────────────────────────────────────────────────────

function OutcomeDisplay({ outcome }: { outcome: AuditItem["outcome"] }) {
  if (outcome === "denied") {
    return <span className="pill red text-[11.5px]">denied</span>;
  }
  if (outcome === "failed") {
    return <span className="text-[12.5px]" style={{ color: "var(--red)" }}>failed</span>;
  }
  return <span className="text-[12.5px]" style={{ color: "var(--green)" }}>success</span>;
}

// ── Resource column ─────────────────────────────────────────────────────────

function ResourceCell({ type, id, projectId }: { type: AuditItem["resourceType"]; id: string | null; projectId: string | null }) {
  const link = resourceLink(type, id);

  if (type === "project") {
    return (
      <span className="text-[13px] text-text-3">
        project <code className="mono text-[12px]">{projectId ? shortId(projectId) : "—"}</code>
      </span>
    );
  }

  if (!id) {
    return <span className="text-[13px] text-text-3">{resourceLabel(type)}</span>;
  }

  return (
    <span className="row gap-[6px]">
      <span className="text-[13px] text-text-3">{resourceLabel(type)}</span>
      {link ? (
        <a href={link} className="mono text-[12px]">
          {shortId(id)}
        </a>
      ) : (
        <code className="mono text-[12px]">{shortId(id)}</code>
      )}
    </span>
  );
}

// ── Main audit page ─────────────────────────────────────────────────────────

export function AuditPage() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters
  const [actorFilter, setActorFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [timeFilter, setTimeFilter] = useState<"all" | "24h" | "7d" | "30d">("all");

  // Which filter dropdown is currently open
  const [openFilter, setOpenFilter] = useState<string | null>(null);

  // 403 forbidden (role too low)
  const [forbidden, setForbidden] = useState(false);

  const toggleFilter = (name: string) => {
    setOpenFilter((prev) => (prev === name ? null : name));
  };

  // Fetch audit data
  const fetchData = useCallback(
    async (cursor?: string) => {
      setError(null);
      setForbidden(false);
      const params = new URLSearchParams();
      params.set("limit", "20");
      if (cursor) params.set("cursor", cursor);
      if (actorFilter) params.set("actor", actorFilter);
      if (actionFilter) params.set("action", actionFilter);
      if (projectFilter) params.set("projectId", projectFilter);

      try {
        const res = await fetch(`/v1/audit?${params.toString()}`);
        if (!res.ok) {
          if (res.status === 403) {
            setForbidden(true);
            setError(null);
            return;
          }
          throw new Error(`Server responded with ${res.status}`);
        }
        const json: AuditListResponse = await res.json();
        if (cursor) {
          setItems((prev) => [...prev, ...json.data]);
        } else {
          setItems(json.data);
        }
        setNextCursor(json.nextCursor);
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError("Failed to load audit records.");
        }
      }
    },
    [actorFilter, actionFilter, projectFilter]
  );

  // Initial load and reload on filter change
  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  // Load more
  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await fetchData(nextCursor);
    setLoadingMore(false);
  };

  // Client-side time filter
  const timeFilteredItems = items.filter((item) => {
    if (timeFilter === "all") return true;
    const then = new Date(item.createdAt).getTime();
    const now = Date.now();
    const cutoffs = {
      "24h": DAY,
      "7d": 7 * DAY,
      "30d": 30 * DAY,
    } as const;
    return now - then <= cutoffs[timeFilter];
  });

  // ── Render ──────────────────────────────────────────────────────────────────

  // Forbidden state (403 — role too low). Reuses the shared PermissionDenied component.
  if (forbidden) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>Audit log</h1>
            <p className="sub">
              Who read what, and when. Metadata only — query text and payloads are never stored here.
            </p>
          </div>
        </div>
        <div className="card">
          <PermissionDenied requiredRole="admin" />
        </div>
      </div>
    );
  }

  // Error state (network/server failure)
  if (error) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>Audit log</h1>
            <p className="sub">
              Who read what, and when. Metadata only — query text and payloads are never stored here.
            </p>
          </div>
        </div>
        <div className="card">
          <EmptyState
            icon={Shield}
            title="Unable to load audit records"
            description={error}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Page header */}
      <div className="page-head">
        <div className="ph-text">
          <h1>Audit log</h1>
          <p className="sub">
            Who read what, and when. Metadata only — query text and payloads are never stored here.
          </p>
        </div>
      </div>

      {/* Filter row */}
      <div className="filter-row" style={{ marginTop: 0 }}>
        <div className="relative">
          <button
            className="filter-chip"
            onClick={() => toggleFilter("actor")}
          >
            Actor
            <ChevronDown className="w-[12px] h-[12px]" />
          </button>
          {openFilter === "actor" && (
            <div className="absolute top-full left-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-40 p-3 min-w-[200px]">
              <input
                className="w-full border border-border rounded px-3 py-[5px] text-[13px] bg-surface-2"
                placeholder="Filter by actor…"
                value={actorFilter}
                onChange={(e) => { setActorFilter(e.target.value); }}
              />
            </div>
          )}
        </div>
        <div className="relative">
          <button
            className="filter-chip"
            onClick={() => toggleFilter("action")}
          >
            Action
            <ChevronDown className="w-[12px] h-[12px]" />
          </button>
          {openFilter === "action" && (
            <div className="absolute top-full left-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-40 p-2 min-w-[220px] max-h-[280px] overflow-y-auto">
              <button
                className={`w-full text-left px-3 py-[5px] text-[13px] rounded hover:bg-surface-2 ${
                  actionFilter === "" ? "font-semibold text-text" : "text-text-2"
                }`}
                onClick={() => { setActionFilter(""); setOpenFilter(null); }}
              >
                All actions
              </button>
              {KNOWN_ACTIONS.map((action) => (
                <button
                  key={action}
                  className={`w-full text-left px-3 py-[5px] text-[13px] rounded hover:bg-surface-2 font-mono ${
                    actionFilter === action ? "font-semibold text-accent bg-accent-soft" : "text-text-2"
                  }`}
                  onClick={() => { setActionFilter(action); setOpenFilter(null); }}
                >
                  {action}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="relative">
          <button
            className="filter-chip"
            onClick={() => toggleFilter("project")}
          >
            Project
            <ChevronDown className="w-[12px] h-[12px]" />
          </button>
          {openFilter === "project" && (
            <div className="absolute top-full left-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-40 p-3 min-w-[200px]">
              <input
                className="w-full border border-border rounded px-3 py-[5px] text-[13px] bg-surface-2"
                placeholder="Filter by project…"
                value={projectFilter}
                onChange={(e) => { setProjectFilter(e.target.value); }}
              />
            </div>
          )}
        </div>
        <div className="relative">
          <button
            className="filter-chip"
            onClick={() => toggleFilter("time")}
          >
            Time range
            <ChevronDown className="w-[12px] h-[12px]" />
          </button>
          {openFilter === "time" && (
            <div className="absolute top-full left-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-40 p-2 min-w-[160px]">
              {(["all", "24h", "7d", "30d"] as const).map((opt) => (
                <button
                  key={opt}
                  className={`w-full text-left px-3 py-[5px] text-[13px] rounded hover:bg-surface-2 ${
                    timeFilter === opt ? "font-semibold text-text" : "text-text-2"
                  }`}
                  onClick={() => { setTimeFilter(opt); setOpenFilter(null); }}
                >
                  {opt === "all" ? "All time" : opt === "24h" ? "Last 24 hours" : opt === "7d" ? "Last 7 days" : "Last 30 days"}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="small muted" style={{ marginLeft: "auto" }}>
          <code className="mono">mcp.*</code> = via agent · others = web UI
        </span>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>Time</th>
                <th style={{ width: 210 }}>Actor</th>
                <th style={{ width: 170 }}>Action</th>
                <th>Resource</th>
                <th style={{ width: 95 }}>Outcome</th>
                <th style={{ width: 130 }}>Request ID</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5].map((i) => (
                <tr key={i}>
                  <td className="muted"><div className="skeleton h-3 w-16" /></td>
                  <td><div className="skeleton h-5 w-28" /></td>
                  <td><div className="skeleton h-4 w-24" /></td>
                  <td><div className="skeleton h-4 w-48" /></td>
                  <td><div className="skeleton h-4 w-14" /></td>
                  <td><div className="skeleton h-4 w-20" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && timeFilteredItems.length === 0 && (
        <div className="card">
          <EmptyState
            icon={Shield}
            title="No audit records in this range"
            description="Reads, searches and payload access will appear here as they happen."
          />
        </div>
      )}

      {/* Data table */}
      {!loading && timeFilteredItems.length > 0 && (
        <>
          <div className="table-card">
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>Time</th>
                    <th style={{ width: 210 }}>Actor</th>
                    <th style={{ width: 170 }}>Action</th>
                    <th>Resource</th>
                    <th style={{ width: 95 }}>Outcome</th>
                    <th style={{ width: 130 }}>Request ID</th>
                  </tr>
                </thead>
                <tbody>
                  {timeFilteredItems.map((item) => (
                    <tr key={item.id}>
                      <td className="muted small" title={item.createdAt}>
                        {relativeTime(item.createdAt)}
                      </td>
                      <td>
                        <ActorDisplay
                          principalId={item.principalId}
                          credentialId={item.credentialId}
                        />
                      </td>
                      <td>
                        <code className="mono small">{item.action}</code>
                      </td>
                      <td>
                        <ResourceCell
                          type={item.resourceType}
                          id={item.resourceId}
                          projectId={item.projectId}
                        />
                      </td>
                      <td>
                        <OutcomeDisplay outcome={item.outcome} />
                      </td>
                      <td>
                        <CopyChip id={item.requestId} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Load more */}
          {nextCursor && (
            <div className="pager">
              <button
                className="btn btn-outline"
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
