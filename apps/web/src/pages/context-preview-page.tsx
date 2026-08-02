import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Sparkles,
  RefreshCw,
  Copy,
  Check,
  AlertTriangle,
  Zap,
  FolderPlus,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeBadge, type ConceptType } from "@/components/ui/type-badge";
import { fetchContext, ApiError } from "@/lib/api";
import { useScope } from "@/lib/scope";

interface ContextData {
  markdown: string;
  budgetUsed: number;
  conceptsIncluded: number;
  conceptsAvailable: number;
}

/** One parsed entry from the server-rendered context markdown. */
interface ContextItem {
  title: string;
  type: string;
  path: string;
  summary: string;
  uuid: string;
}

/**
 * Parse the real server markdown (apps/server/src/http/routes/context.ts):
 *
 *     # Team Context
 *
 *     ## {title}
 *     **{type}** · {path}
 *     {one-line summary}
 *
 *     [View details](teamem://concept/{uuid})
 *
 *     ---
 *
 *     ## {next title}
 *     ...
 *
 * The server emits a `# Team Context` h1 header and `---` separators.
 * Empty projects get an italic placeholder message instead of entries (and
 * conceptsIncluded === 0 — which the page uses for the honest empty state).
 */
function parseContextMarkdown(md: string): ContextItem[] {
  const items: ContextItem[] = [];
  let current: {
    title: string;
    type: string | null;
    path: string | null;
    summaryLines: string[];
    uuid: string | null;
  } | null = null;

  const flush = () => {
    if (current && current.uuid) {
      items.push({
        title: current.title,
        type: current.type ?? "concept",
        path: current.path ?? "",
        summary: current.summaryLines.join(" ").trim(),
        uuid: current.uuid,
      });
    }
    current = null;
  };

  for (const rawLine of md.split("\n")) {
    const line = rawLine.trim();

    // Skip the document header, separators, and blank lines.
    if (line === "" || line === "---" || /^#(?!#)\s/.test(line)) continue;

    // New concept entry heading.
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      flush();
      current = { title: heading[1]!.trim(), type: null, path: null, summaryLines: [], uuid: null };
      continue;
    }

    // Type/path line: **{type}** · {path}
    const typePath = line.match(/^\*\*(\w+)\*\*\s*·\s*(.+)$/);
    if (typePath && current) {
      current.type = typePath[1]!;
      current.path = typePath[2]!;
      continue;
    }

    // Entry link — terminates the current entry.
    const link = line.match(
      /^\[View details\]\(teamem:\/\/concept\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/,
    );
    if (link && current) {
      current.uuid = link[1]!;
      flush();
      continue;
    }

    // Anything else inside an entry is summary text.
    if (current) {
      current.summaryLines.push(line);
    }
    // Lines outside any entry (e.g. the italic empty-state message from the
    // server) are ignored — the empty state is driven by conceptsIncluded.
  }

  flush();
  return items;
}

export function ContextPreviewPage() {
  const scope = useScope();
  const [data, setData] = useState<ContextData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!scope.projectId) return;
    try {
      setLoading(true);
      setError(null);
      const resp = await fetchContext(scope.projectId);
      setData(resp.data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(
          "This portal session cannot read context yet — the data-plane API requires an API key, and web-session read access is not available on this server.",
        );
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to load context preview");
      }
    } finally {
      setLoading(false);
    }
  }, [scope.projectId]);

  useEffect(() => {
    if (scope.status === "ready") {
      load();
    }
  }, [scope.status, load]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText("teamem cli install-hook");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  // ── Scope states ──

  if (scope.status === "loading") {
    return <ContextPreviewSkeleton />;
  }

  if (scope.status === "signed-out") {
    return (
      <div className="card">
        <EmptyState
          icon={Sparkles}
          title="Sign in required"
          description="You need to sign in with GitHub to preview agent context."
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
  // showing a skeleton that never resolves. Surface the real reason instead
  // of a fake loading state.
  if (!scope.projectId) {
    return (
      <div className="card">
        <EmptyState
          icon={FolderPlus}
          title="No project yet"
          description="Your team doesn't have a project yet — create one to start previewing agent context."
          actions={
            <a className="btn btn-primary" href="/onboarding">
              Create a project
            </a>
          }
        />
      </div>
    );
  }

  const items = data ? parseContextMarkdown(data.markdown) : [];
  const isEmpty = !loading && !error && data !== null && data.conceptsIncluded === 0;
  const budgetPercent =
    data && data.budgetUsed > 0
      ? Math.min(Math.round((data.budgetUsed / 800) * 100), 100)
      : 0;

  // ── Main render ──
  return (
    <div className="content narrow">
      {/* Page header */}
      <div className="page-head">
        <div className="ph-text">
          <h1>Context preview</h1>
          <p className="sub">
            What your agent automatically knows at the start of every new
            session — injected by the SessionStart hook from{" "}
            <code className="mono">GET /v1/context</code>.
          </p>
        </div>
        <div className="ph-actions">
          <button
            className="btn btn-outline btn-sm"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="banner error mb-4">
          <AlertTriangle className="w-4 h-4" />
          <div>{error}</div>
          <div className="b-actions">
            <button className="btn btn-sm btn-outline" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && <ContextPreviewSkeleton />}

      {/* Honest empty state — the server included zero concepts. */}
      {isEmpty && (
        <div className="card">
          <EmptyState
            icon={Sparkles}
            title="Nothing to inject yet"
            description="Context is built from your team's top pages. Once the compiler produces knowledge, the SessionStart hook will include it automatically."
            actions={
              <Link className="btn btn-outline" to="/settings/sources">
                Feed the compiler
              </Link>
            }
          />
        </div>
      )}

      {/* Default — has data */}
      {!loading && !error && data && data.conceptsIncluded > 0 && (
        <div className="stack">
          <div className="card">
            <div
              className="card-head"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 18px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "15px" }}>Injected summary</h3>
              <div className="budget">
                <span className="mono">~{data.budgetUsed} / 800 tokens</span>
                <span className="bar">
                  <i style={{ width: `${budgetPercent}%` }} />
                </span>
              </div>
            </div>
            <div className="card-body" style={{ padding: "0 0 8px" }}>
              {items.map((item) => (
                <div className="ctx-item" key={item.uuid} style={{ padding: "13px 18px" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ci-title">
                      <Link to={`/concept/${item.uuid}`}>{item.title}</Link>
                    </div>
                    <div className="flex items-center gap-2 mb-1">
                      <TypeBadge type={item.type as ConceptType} />
                      <span className="small muted">{item.path}</span>
                    </div>
                    {item.summary && <div className="ci-sum">{item.summary}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Install hook command */}
          <div className="card">
            <div className="card-body" style={{ padding: "16px" }}>
              <div className="cmd-label">
                <Zap className="w-4 h-4" />
                Not installed yet? Add the SessionStart hook to Claude Code:
              </div>
              <div className="cmd-block">
                <code>teamem cli install-hook</code>
                <button className="copy-btn" onClick={handleCopy}>
                  {copied ? (
                    <>
                      <Check className="w-3 h-3" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copy
                    </>
                  )}
                </button>
              </div>
              <p style={{ marginTop: "10px" }} className="hint small muted">
                After installing, every new agent session starts with the
                summary above. Selection favors recent, high-confidence pages
                and fits the token budget.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ContextPreviewSkeleton() {
  return (
    <div className="stack">
      <div className="card">
        <div className="card-body" style={{ padding: "16px" }}>
          <Skeleton className="h-[18px] w-[40%] mb-[18px]" />
          <Skeleton className="h-[48px] w-full mb-[12px]" style={{ borderRadius: "8px" }} />
          <Skeleton className="h-[48px] w-full mb-[12px]" style={{ borderRadius: "8px" }} />
          <Skeleton className="h-[48px] w-[80%]" style={{ borderRadius: "8px" }} />
        </div>
      </div>
    </div>
  );
}
