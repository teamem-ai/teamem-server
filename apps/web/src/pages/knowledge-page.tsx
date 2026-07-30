import { EmptyState, DegradedBanner, ConceptRowSkeleton, ViewerInfoBanner } from "@/components/ui";
import { BookOpen, Search } from "lucide-react";

/** Knowledge list page — placeholder showing app shell with honest empty state.
 *  No hardcoded demo data. Will consume GET /v1/concepts when the backend
 *  integration task wires it up. */
export function KnowledgePage() {
  // In the future this will fetch from the API. For now: honest empty state.
  const hasData = false; // placeholder — will be replaced by real API consumption
  const isViewer = false;
  const isDegraded = false;
  const isSearching = false;
  const hasNoResults = false;

  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <h1>Knowledge</h1>
          <p className="sub">
            Team knowledge compiled from real development activity — every page
            carries its evidence.
          </p>
        </div>
      </div>

      {/* Viewer info */}
      {isViewer && <ViewerInfoBanner />}

      {/* Search bar (member+) */}
      {!isViewer && (
        <div className="flex gap-[10px] items-center mb-4">
          <div className="search-wrap flex-1 min-w-[240px] max-w-[520px]">
            <Search className="w-4 h-4 absolute left-[11px] top-1/2 -translate-y-1/2 text-text-3" />
            <input
              className="search-input"
              placeholder='Ask in natural language… e.g. "why did we pick postgres over a vector DB?"'
            />
          </div>
          <button className="btn btn-primary">Search</button>
        </div>
      )}

      {/* Degraded banner */}
      {isDegraded && <DegradedBanner className="mb-4" />}

      {/* Loading skeleton */}
      {false && (
        <div className="card py-[6px] px-5">
          <ConceptRowSkeleton />
          <ConceptRowSkeleton />
          <ConceptRowSkeleton />
          <ConceptRowSkeleton />
        </div>
      )}

      {/* Empty state (honest — no fake data) */}
      {!hasData && !isSearching && (
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

      {/* No results */}
      {hasNoResults && (
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
