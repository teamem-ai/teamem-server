import { useState, useEffect, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BookOpen, FolderPlus, Search, AlertTriangle } from "lucide-react";
import { TypeBadge, type ConceptType } from "@/components/ui/type-badge";
import { StatusBadge, type ConceptStatus } from "@/components/ui/status-badge";
import { ConfidenceMeter } from "@/components/ui/confidence-meter";
import { EmptyState } from "@/components/ui/empty-state";
import { AvatarStack } from "@/components/ui/avatar-stack";
import { Banner, DegradedBanner } from "@/components/ui/banner";
import { ConceptRowSkeleton } from "@/components/ui/skeleton";
import { ViewerInfoBanner } from "@/components/ui/permission-denied";
import { fetchConcepts, searchConcepts, ApiError } from "@/lib/api";
import { ExportOkfButton, useExportOkf } from "@/components/export/export-okf-button";
import { useScope } from "@/lib/scope";
import { relativeTime, formatFull } from "@/lib/date";
import type { ConceptSummary, SearchResult } from "@teamem/schema";

type ViewMode = "list" | "search";

/** Knowledge list — default landing page.
 *
 *  Scope (team/project/role) comes from the real web session via useScope().
 *  List rows render the ConceptSummary DTO fields: type/status/confidence/
 *  title/path/tags/lastConfirmed plus evidenceCount and contributor avatars.
 *
 *  Filters map 1:1 to the conceptListQuery contract params (type, status,
 *  tag, contributor). There is no confidence filter: the contract has no
 *  confidence param, and client-side filtering across cursor pages would be
 *  dishonest. */
export function KnowledgePage() {
  const scope = useScope();
  const [searchParams, setSearchParams] = useSearchParams();

  const [viewMode, setViewMode] = useState<ViewMode>("list");

  // List state
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchNextCursor, setSearchNextCursor] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [searchDegraded, setSearchDegraded] = useState(false);

  // Filters — initialized from the URL so tag links from a detail page work.
  const [typeFilter, setTypeFilter] = useState<string>(searchParams.get("type") ?? "");
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") ?? "");
  const [tagFilter, setTagFilter] = useState<string>(searchParams.get("tag") ?? "");
  const [contributorFilter, setContributorFilter] = useState<string>(
    searchParams.get("contributor") ?? "",
  );

  const projectId = scope.projectId;

  // OKF export entry (M3-EXPORT-05) — state machine for one download.
  // projectId may be null (signed-out / no project): the hook guards the
  // call and the button is only rendered once a real project is active.
  const exportCtl = useExportOkf(projectId);

  const loadConcepts = useCallback(
    async (cursor?: string, append = false) => {
      if (!projectId) return;
      try {
        if (append) setLoadingMore(true);
        else setLoading(true);
        setError(null);

        const resp = await fetchConcepts({
          projectId,
          type: typeFilter || undefined,
          status: statusFilter || undefined,
          tag: tagFilter || undefined,
          contributor: contributorFilter || undefined,
          cursor,
          limit: 20,
        });
        if (append) {
          setConcepts((prev) => [...prev, ...resp.data]);
        } else {
          setConcepts(resp.data);
        }
        setNextCursor(resp.nextCursor);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setError(
            "This portal session cannot read knowledge yet — the data-plane API requires an API key, and web-session read access is not available on this server.",
          );
        } else if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Failed to load concepts");
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [projectId, typeFilter, statusFilter, tagFilter, contributorFilter],
  );

  const doSearch = useCallback(
    async (query: string, cursor?: string, append = false) => {
      if (!projectId || !query.trim()) return;
      try {
        setSearchLoading(true);
        setSearchError(null);
        setViewMode("search");
        setSearchedQuery(query);

        const resp = await searchConcepts({
          projectId,
          query: query.trim(),
          type: typeFilter || undefined,
          status: statusFilter || undefined,
          cursor,
          limit: 20,
        });

        if (append) {
          setSearchResults((prev) => [...prev, ...resp.results]);
        } else {
          setSearchResults(resp.results);
        }
        setSearchNextCursor(resp.nextCursor);
        setSearchDegraded(resp.degraded);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setSearchError(
            "This portal session cannot search yet — the data-plane API requires an API key, and web-session read access is not available on this server.",
          );
        } else if (err instanceof ApiError) {
          setSearchError(err.message);
        } else {
          setSearchError("Search failed");
        }
      } finally {
        setSearchLoading(false);
      }
    },
    [projectId, typeFilter, statusFilter],
  );

  // Single data-loading effect: fires when the scope becomes ready, when
  // the active project changes, or when any contract filter changes.
  // loadConcepts is memoized on exactly those inputs, so this cannot loop.
  useEffect(() => {
    if (scope.status !== "ready" || !projectId) return;
    setViewMode("list");
    setConcepts([]);
    loadConcepts();
  }, [scope.status, projectId, typeFilter, statusFilter, tagFilter, contributorFilter, loadConcepts]);

  // Sync filter state → URL query params (so tag links from detail pages work).
  useEffect(() => {
    const params: Record<string, string> = {};
    if (typeFilter) params["type"] = typeFilter;
    if (statusFilter) params["status"] = statusFilter;
    if (tagFilter) params["tag"] = tagFilter;
    if (contributorFilter) params["contributor"] = contributorFilter;
    setSearchParams(params, { replace: true });
  }, [typeFilter, statusFilter, tagFilter, contributorFilter, setSearchParams]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) doSearch(searchQuery);
  };

  const handleLoadMore = () => {
    if (viewMode === "list" && nextCursor) {
      loadConcepts(nextCursor, true);
    } else if (viewMode === "search" && searchNextCursor) {
      doSearch(searchedQuery, searchNextCursor, true);
    }
  };

  const hasMore = viewMode === "list" ? nextCursor !== null : searchNextCursor !== null;
  const isViewer = scope.isViewer;

  // ── Scope states ──

  if (scope.status === "loading") {
    return (
      <div className="card" style={{ padding: "6px 20px 20px" }}>
        <ConceptRowSkeleton />
        <ConceptRowSkeleton />
        <ConceptRowSkeleton />
        <ConceptRowSkeleton />
      </div>
    );
  }

  if (scope.status === "signed-out") {
    return (
      <div className="card">
        <EmptyState
          icon={BookOpen}
          title="Sign in required"
          description="You need to sign in with GitHub to browse this team's knowledge."
          actions={
            <a className="btn btn-primary" href="/auth/github">
              Sign in with GitHub
            </a>
          }
        />
      </div>
    );
  }

  if (scope.status === "error") {
    return (
      <div className="banner error">
        <AlertTriangle className="w-4 h-4" />
        <div>{scope.error ?? "Failed to resolve your team scope."}</div>
        <div className="b-actions">
          <button className="btn btn-sm btn-outline" onClick={scope.reload}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // scope is "ready" (team resolved) but there is no project yet — without
  // this branch the data-fetch effect above never fires (it requires a
  // projectId) and `loading` would stay stuck at its initial `true` forever,
  // showing a skeleton table that never resolves. Surface the real reason
  // instead of a fake loading state.
  if (!projectId) {
    return (
      <div className="card">
        <EmptyState
          icon={FolderPlus}
          title="No project yet"
          description="Your team doesn't have a project yet — create one to start compiling knowledge."
          actions={
            <a className="btn btn-primary" href="/onboarding">
              Create a project
            </a>
          }
        />
      </div>
    );
  }

  // ── Render helpers ──

  const renderConceptRow = (item: ConceptSummary, linkTo: string) => (
    <Link
      key={item.uuid}
      to={linkTo}
      className="krow"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <div className="k-main">
        <div className="k-title">
          <TypeBadge type={item.type as ConceptType} />
          <span>{item.title}</span>
          {item.status !== "active" && (
            <StatusBadge status={item.status as ConceptStatus} />
          )}
        </div>
        <div className="k-meta">
          <span className="path">{item.path}</span>
          <span className="small muted">
            {item.evidenceCount} evidence
          </span>
          <span title={formatFull(item.lastConfirmed)}>
            Last confirmed {relativeTime(item.lastConfirmed)}
          </span>
        </div>
      </div>
      <div className="k-side">
        <div className="flex flex-col items-end gap-1">
          <ConfidenceMeter level={item.confidence as "high" | "medium" | "low"} />
          <AvatarStack contributors={item.contributors} />
        </div>
      </div>
    </Link>
  );

  // ── Main render ──

  return (
    <div>
      {/* Page header */}
      <div className="page-head">
        <div className="ph-text">
          <h1>Knowledge</h1>
          <p className="sub">
            Team knowledge compiled from real development activity — every page
            carries its evidence.
          </p>
        </div>
        {/* Export is member+ (server enforces the same gate); viewer never
            sees the entry. Requires an active project to have something real
            to package — without one the page already shows its honest
            "No project yet" empty state. */}
        {!isViewer && projectId && (
          <div className="ph-actions">
            <ExportOkfButton busy={exportCtl.busy} onDownload={exportCtl.download} />
          </div>
        )}
      </div>

      {/* Export feedback — visible success (server-provided filename) or a
          surfaced error with a retry; never a silent failure. */}
      {exportCtl.feedback && (
        <Banner
          variant={exportCtl.feedback.variant}
          className="mb-4"
          role={exportCtl.feedback.variant === "error" ? "alert" : "status"}
          actions={
            exportCtl.feedback.variant === "error" ? (
              <button
                className="btn btn-sm btn-outline"
                onClick={exportCtl.download}
              >
                Retry
              </button>
            ) : undefined
          }
        >
          {exportCtl.feedback.message}
        </Banner>
      )}

      {/* Viewer info (role comes from the real session) */}
      {isViewer && <ViewerInfoBanner />}

      {/* Search bar (member+) */}
      {!isViewer && (
        <form onSubmit={handleSearch}>
          <div className="flex gap-[10px] items-center mb-4">
            <div className="search-wrap flex-1 min-w-[240px] max-w-[520px]">
              <Search className="w-4 h-4 absolute left-[11px] top-1/2 -translate-y-1/2 text-text-3" />
              <input
                className="search-input"
                placeholder='Ask in natural language… e.g. "why did we pick postgres over a vector DB?"'
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={searchLoading}>
              Search
            </button>
          </div>
        </form>
      )}

      {/* Filters — map 1:1 to the conceptListQuery contract params.
          Viewer sees only Type/Status (design spec). */}
      <div className="filter-row mb-5">
        <FilterChip label="Type" options={TYPE_OPTIONS} value={typeFilter} onChange={setTypeFilter} />
        <FilterChip label="Status" options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} />
        {!isViewer && (
          <>
            <TagFilterInput value={tagFilter} onChange={setTagFilter} />
            <ContributorFilterInput value={contributorFilter} onChange={setContributorFilter} />
          </>
        )}
        <span className="small muted" style={{ marginLeft: "auto" }}>
          Sorted by <strong>last confirmed</strong>
        </span>
      </div>

      {/* Degraded banner (search) */}
      {viewMode === "search" && searchDegraded && <DegradedBanner className="mb-4" />}

      {/* Search result meta */}
      {viewMode === "search" && searchedQuery && !searchLoading && (
        <div className="flex gap-3 items-center mb-[12px]">
          <span className="small muted">
            {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for{" "}
            <strong>"{searchedQuery}"</strong>
            {searchDegraded ? " · keyword" : " · semantic"}
          </span>
          <span
            className="pill"
            title="Relevance is cosine similarity — a correct hit can score ~0.36, so we show rank, not raw numbers"
          >
            Top match first
          </span>
        </div>
      )}

      {/* Error states */}
      {error && (
        <div className="banner error mb-4">
          <AlertTriangle className="w-4 h-4" />
          <div>{error}</div>
          <div className="b-actions">
            <button className="btn btn-sm btn-outline" onClick={() => loadConcepts()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {searchError && (
        <div className="banner error mb-4">
          <AlertTriangle className="w-4 h-4" />
          <div>{searchError}</div>
          <div className="b-actions">
            <button className="btn btn-sm btn-outline" onClick={() => setViewMode("list")}>
              Back to list
            </button>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="card" style={{ padding: "6px 20px 20px" }}>
          <ConceptRowSkeleton />
          <ConceptRowSkeleton />
          <ConceptRowSkeleton />
          <ConceptRowSkeleton />
        </div>
      )}

      {/* Empty state (no knowledge yet — list mode) */}
      {!loading && !error && viewMode === "list" && concepts.length === 0 && (
        <div className="card">
          <EmptyState
            icon={BookOpen}
            title="No knowledge yet"
            description="Pages appear here once events are compiled. Feed the compiler from any of these:"
            actions={
              <>
                <a className="btn btn-outline" href="/settings/sources">
                  Connect GitHub
                </a>
                <a className="btn btn-outline" href="/settings/sources">
                  Run teamem init
                </a>
                <a className="btn btn-outline" href="/settings/sources">
                  Hook up your agent via MCP
                </a>
              </>
            }
          />
        </div>
      )}

      {/* Concept list */}
      {!loading && !error && viewMode === "list" && concepts.length > 0 && (
        <div className="card" style={{ padding: "0" }}>
          {concepts.map((c) => renderConceptRow(c, `/concept/${c.uuid}`))}
          {hasMore && (
            <div className="pager">
              <button className="btn btn-outline" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Search results */}
      {!loading && viewMode === "search" && searchResults.length > 0 && (
        <div className="card" style={{ padding: "0" }}>
          {searchResults.map((r) => renderConceptRow(r, `/concept/${r.uuid}`))}
          {hasMore && (
            <div className="pager">
              <button
                className="btn btn-outline"
                onClick={handleLoadMore}
                disabled={loadingMore || searchLoading}
              >
                {searchLoading ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* No search results */}
      {!loading &&
        viewMode === "search" &&
        !searchLoading &&
        searchResults.length === 0 &&
        searchedQuery && (
          <div className="card">
            <EmptyState
              icon={Search}
              title="No pages match your search"
              description="Try different words — semantic search understands paraphrases, so describe the problem your way."
            />
          </div>
        )}
    </div>
  );
}

// ── Filter controls ──

const TYPE_OPTIONS = [
  { value: "decision", label: "Decision" },
  { value: "gotcha", label: "Gotcha" },
  { value: "convention", label: "Convention" },
  { value: "runbook", label: "Runbook" },
  { value: "service", label: "Service" },
  { value: "concept", label: "Concept" },
];

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "disputed", label: "Disputed" },
  { value: "superseded", label: "Superseded" },
  { value: "needs-review", label: "Needs review" },
];

function FilterChip({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className="filter-chip"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ appearance: "auto", cursor: "pointer" }}
      aria-label={`Filter by ${label}`}
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Text input styled as a filter chip for the contract `tag` param. */
function TagFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="text"
      className="filter-chip"
      placeholder="Tag"
      aria-label="Filter by tag"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ minWidth: "80px", maxWidth: "160px", cursor: "text", appearance: "none" }}
    />
  );
}

/** Text input styled as a filter chip for the contract `contributor` param
 *  (a principal ID, per conceptListQuery). */
function ContributorFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="text"
      className="filter-chip"
      placeholder="Contributor"
      aria-label="Filter by contributor principal ID"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ minWidth: "100px", maxWidth: "200px", cursor: "text", appearance: "none" }}
    />
  );
}
