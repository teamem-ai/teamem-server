import { useState, useEffect, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  AlertTriangle,
  Link2,
  Copy,
  ExternalLink,
  Bot,
  GitPullRequest,
  GitCommit,
  FileCode,
  Sparkles,
  Check,
  Github,
} from "lucide-react";
import { TypeBadge, type ConceptType } from "@/components/ui/type-badge";
import {
  StatusBadge,
  type ConceptStatus,
} from "@/components/ui/status-badge";
import { ConfidenceMeter } from "@/components/ui/confidence-meter";
import { SoonBadge } from "@/components/ui/soon-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { NotFound } from "@/components/ui/not-found";
import { MarkdownBody } from "@/components/ui/markdown-body";
import { fetchConcept, ApiError } from "@/lib/api";
import { useScope } from "@/lib/scope";
import { formatFull, formatDate } from "@/lib/date";
import { cn } from "@/lib/utils";
import type { Concept, Evidence, PrincipalRef } from "@teamem/schema";

export function ConceptDetailPage() {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const scope = useScope();
  const [concept, setConcept] = useState<Concept | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!uuid || !scope.projectId) return;
    try {
      setLoading(true);
      setError(null);
      setNotFound(false);
      const data = await fetchConcept(uuid, scope.projectId);
      setConcept(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else if (err instanceof ApiError && err.status === 401) {
        setError(
          "This portal session cannot read knowledge yet — the data-plane API requires an API key, and web-session read access is not available on this server.",
        );
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to load concept page");
      }
    } finally {
      setLoading(false);
    }
  }, [uuid, scope.projectId]);

  useEffect(() => {
    if (scope.status === "ready") {
      load();
    }
  }, [scope.status, load]);

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // clipboard not available
    }
  };

  /** Intercept clicks on teamem:// links rendered in the markdown body and
   *  route them through React Router instead of a full page navigation. */
  const handleBodyClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (!anchor) return;
      const teamemHref = anchor.getAttribute("data-teamem-href");
      if (!teamemHref) return;
      e.preventDefault();
      // Extract uuid from teamem://concept/<uuid>
      const uuidMatch = teamemHref.match(
        /teamem:\/\/concept\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
      );
      if (uuidMatch?.[1]) {
        navigate(`/concept/${uuidMatch[1]}`);
      }
    },
    [navigate],
  );

  // ── Scope states ──
  if (scope.status === "loading") {
    return <ConceptDetailSkeleton />;
  }

  if (scope.status === "signed-out") {
    return (
      <div className="card">
        <div className="empty-state py-16">
          <div className="e-icon">
            <AlertTriangle />
          </div>
          <h3>Sign in required</h3>
          <p>You need to sign in with GitHub to view this page.</p>
          <div className="e-actions">
            <a className="btn btn-primary" href="/auth/github">
              Sign in with GitHub
            </a>
          </div>
        </div>
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

  // ── Loading ──
  if (loading) {
    return <ConceptDetailSkeleton />;
  }

  // ── 404 ──
  if (notFound) {
    return <NotFound />;
  }

  // ── Error ──
  if (error || !concept) {
    return (
      <div>
        <Link to="/knowledge" className="btn btn-ghost btn-sm mb-4">
          <ArrowLeft className="w-4 h-4" /> Knowledge
        </Link>
        <div className="banner error mb-4">
          <AlertTriangle className="w-4 h-4" />
          <div>{error ?? "Concept not found"}</div>
          <div className="b-actions">
            <button className="btn btn-sm btn-outline" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isDisputed = concept.status === "disputed";
  const hasContributors = concept.contributors && concept.contributors.length > 0;

  return (
    <div className="content wide">
      {/* Back link */}
      <Link
        to="/knowledge"
        className="btn btn-ghost btn-sm inline-flex items-center gap-1.5 mb-[14px]"
      >
        <ArrowLeft className="w-4 h-4" /> Knowledge
      </Link>

      {/* Disputed banner */}
      {isDisputed && (
        <div className="banner warn mb-4">
          <AlertTriangle className="w-4 h-4" />
          <div>
            <span className="b-title">Conflicting evidence — disputed. </span>
            This page records two opposing positions in its body. It stays High
            confidence; the conflict is about what was decided, not how well
            it&apos;s supported.
          </div>
          <div className="b-actions">
            <button
              className="btn btn-sm btn-outline"
              disabled
              title="Compare both positions side by side with their evidence — coming in V1.5"
            >
              Reconciliation <SoonBadge />
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="c-head">
        <div className="c-badges">
          <TypeBadge type={concept.type as ConceptType} />
          <StatusBadge status={concept.status as ConceptStatus} />
          <ConfidenceMeter level={concept.confidence as "high" | "medium" | "low"} />
        </div>
        <h1 className="c-title">{concept.title}</h1>
        <div className="c-meta">
          <button
            className="copy-chip"
            title="Copy path"
            onClick={() => handleCopy(concept.path, "path")}
          >
            <Link2 className="w-3 h-3" />
            {concept.path}
            {copied === "path" ? (
              <Check className="w-3 h-3 text-green-500" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
          <span title={formatFull(concept.lastConfirmed)}>
            Last confirmed {formatFull(concept.lastConfirmed)}
          </span>
          <span title={formatFull(concept.createdAt)}>
            Created {formatDate(concept.createdAt)}
          </span>
          <button
            className="copy-chip"
            title="Copy UUID"
            onClick={() => handleCopy(concept.uuid, "uuid")}
          >
            UUID {concept.uuid.slice(0, 8)}
            {copied === "uuid" ? (
              <Check className="w-3 h-3 text-green-500" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
          <button
            className="copy-chip"
            title="Copy link to this page"
            onClick={() =>
              handleCopy(window.location.href, "link")
            }
          >
            <ExternalLink className="w-3 h-3" /> Copy link
            {copied === "link" ? (
              <Check className="w-3 h-3 text-green-500" />
            ) : null}
          </button>
        </div>
        {concept.tags && concept.tags.length > 0 && (
          <div className="c-tags">
            {concept.tags.map((tag: string) => (
              <Link key={tag} to={`/knowledge?tag=${tag}`} className="tag">
                {tag}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Body + sidebar grid */}
      <div className="concept-grid">
        {/* Body */}
        <div className="card">
          <div className="card-body" style={{ padding: "26px 30px" }} onClick={handleBodyClick}>
            <MarkdownBody body={concept.body} />
            {isDisputed && (
              <p className="small muted" style={{ marginTop: "18px" }}>
                Both positions were compiled from separate repo files (see
                evidence). The compiler does not map which evidence supports
                which position — that mapping is part of the upcoming
                reconciliation feature.
              </p>
            )}
          </div>
        </div>

        {/* Right rail */}
        <div className="rail">
          {/* Evidence */}
          <div className="card">
            <div className="card-body" style={{ padding: "16px" }}>
              <h4 style={{ margin: "0 0 12px 0", fontSize: "14px" }}>
                Evidence · {concept.evidence.length}
              </h4>
              <div className="stack" style={{ gap: "10px" }}>
                {concept.evidence.map((ev: Evidence, i: number) => (
                  <EvidenceCard key={i} evidence={ev} />
                ))}
              </div>
            </div>
          </div>

          {/* Contributors */}
          <div className="card">
            <div className="card-body" style={{ padding: "16px" }}>
              <h4 style={{ margin: "0 0 8px 0", fontSize: "14px" }}>
                Contributors · {concept.contributors?.length ?? 0}
              </h4>
              {hasContributors ? (
                <div>
                  {concept.contributors.map((c) => (
                    <ContributorRow key={c.principalId} contributor={c} />
                  ))}
                </div>
              ) : (
                <ContributorEmptyState evidence={concept.evidence} isDisputed={isDisputed} />
              )}
            </div>
          </div>

          {/* Timeline */}
          {concept.evidence.length > 0 && (
            <div className="card">
              <div className="card-body" style={{ padding: "16px" }}>
                <h4 style={{ margin: "0 0 14px 0", fontSize: "14px" }}>
                  Timeline
                </h4>
                <div className="timeline">
                  {[...concept.evidence]
                    .sort(
                      (a, b) =>
                        new Date(b.at).getTime() - new Date(a.at).getTime(),
                    )
                    .map((ev, i) => (
                      <div className="tl-item" key={i}>
                        <span
                          className={`tl-dot${i > 0 ? " gray" : ""}`}
                        />
                        <div className="tl-time">
                          {formatFull(ev.at)}
                        </div>
                        <div className="tl-title">
                          {evidenceLabel(ev)}
                        </div>
                        <div className="tl-sub">
                          {evidenceSub(ev)}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Evidence sub-components ──

function EvidenceCard({ evidence: ev }: { evidence: Evidence }) {
  const href = evidenceHref(ev);
  const kindLabel = evidenceKindLabel(ev.kind);
  const subLabel = evidenceSubLabel(ev.kind);
  const ref = evidenceRef(ev);
  const time = formatFull(ev.at);
  const timeLabel = ev.kind === "repo_file" ? "Snapshot" : "Occurred";

  const content = (
    <div className="ev-item">
      <div className="ev-ic">
        <EvidenceIcon kind={ev.kind} />
      </div>
      <div className="ev-main">
        <div className="ev-kind">
          {kindLabel}
          {subLabel && (
            <span style={{ fontWeight: 400 }} className="muted">
              {" "}
              · {subLabel}
            </span>
          )}
        </div>
        {ref && <div className="ev-ref">{ref}</div>}
        <div className="ev-time">
          {timeLabel} {time}
        </div>
      </div>
      <div className="ev-ext">
        <ExternalLink className="w-3.5 h-3.5" />
      </div>
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="no-underline hover:no-underline"
      >
        {content}
      </a>
    );
  }

  // For mcp_write, link to event detail
  if (ev.kind === "mcp_write" && ev.ref) {
    return (
      <Link
        to={`/events/${ev.ref}`}
        className="no-underline hover:no-underline"
      >
        {content}
      </Link>
    );
  }

  return content;
}

function EvidenceIcon({ kind }: { kind: Evidence["kind"] }) {
  switch (kind) {
    case "pr":
      return <GitPullRequest className="w-4 h-4" />;
    case "commit":
      return <GitCommit className="w-4 h-4" />;
    case "repo_file":
      return <FileCode className="w-4 h-4" />;
    case "mcp_write":
      return <Sparkles className="w-4 h-4" />;
    case "pr_comment":
      return <GitPullRequest className="w-4 h-4" />;
    case "issue":
      return <GitPullRequest className="w-4 h-4" />;
    case "manual":
      return <FileCode className="w-4 h-4" />;
    default:
      return <FileCode className="w-4 h-4" />;
  }
}

function evidenceKindLabel(kind: Evidence["kind"]): string {
  switch (kind) {
    case "pr":
      return "Pull request";
    case "commit":
      return "Commit";
    case "repo_file":
      return "Repo file";
    case "mcp_write":
      return "Agent write (MCP)";
    case "pr_comment":
      return "PR comment";
    case "issue":
      return "Issue";
    case "manual":
      return "Manual";
    default:
      return kind;
  }
}

function evidenceSubLabel(kind: Evidence["kind"]): string | null {
  switch (kind) {
    case "pr":
    case "commit":
      return "permalink";
    case "repo_file":
      return "commit-pinned";
    case "mcp_write":
      return "internal event";
    default:
      return null;
  }
}

function evidenceHref(ev: Evidence): string | null {
  if ("ref" in ev && typeof ev.ref === "string" && ev.kind !== "mcp_write") {
    try {
      new URL(ev.ref);
      return ev.ref;
    } catch {
      return null;
    }
  }
  if (
    ev.kind === "repo_file" &&
    ev.repo &&
    ev.commitSha &&
    ev.path
  ) {
    return `https://github.com/${ev.repo}/blob/${ev.commitSha}/${ev.path}`;
  }
  return null;
}

function evidenceRef(ev: Evidence): string | null {
  if (ev.kind === "repo_file") {
    return `${ev.repo}@${ev.commitSha?.slice(0, 7)} · ${ev.path}`;
  }
  if (ev.kind === "mcp_write" && ev.ref) {
    return ev.ref;
  }
  if ("ref" in ev && typeof ev.ref === "string") {
    const url = ev.ref;
    try {
      const u = new URL(url);
      return u.pathname.replace(/^\//, "") + (u.search || "");
    } catch {
      return url;
    }
  }
  return null;
}

function evidenceLabel(ev: Evidence): string {
  switch (ev.kind) {
    case "repo_file":
      return "Repo file ingested";
    case "pr":
      return "PR merged";
    case "commit":
      return "Push · commit";
    case "mcp_write":
      return "Agent write (MCP)";
    case "issue":
      return "Issue";
    case "pr_comment":
      return "PR comment";
    case "manual":
      return "Manual entry";
    default:
      return (ev as Evidence).kind;
  }
}

function evidenceSub(ev: Evidence): string {
  if (ev.kind === "mcp_write" && ev.ref) {
    return ev.ref;
  }
  if (ev.kind === "repo_file") {
    return ev.path ?? "";
  }
  if ("ref" in ev && typeof ev.ref === "string") {
    try {
      const u = new URL(ev.ref);
      return u.pathname;
    } catch {
      return ev.ref;
    }
  }
  return "";
}

function ContributorEmptyState({
  evidence,
  isDisputed,
}: {
  evidence: Evidence[];
  isDisputed: boolean;
}) {
  const allMcp = evidence.length > 0 && evidence.every((ev) => ev.kind === "mcp_write");
  const allRepoFile = evidence.length > 0 && evidence.every((ev) => ev.kind === "repo_file");

  let message: string;
  if (isDisputed) {
    message =
      "Both positions were compiled from separate repo files, but no verified human contributors are recorded for either position.";
  } else if (allMcp) {
    message =
      "Agent writes via MCP are attributed to the invoking principal; if that principal was client_claimed it is intentionally excluded from the contributor list.";
  } else if (allRepoFile) {
    message =
      "No verified contributors. Events that produced this page were client_claimed — self-reported identities don’t appear here.";
  } else {
    message =
      "No verified contributors. Events that produced this page were client_claimed — self-reported identities don’t appear here.";
  }

  return (
    <div className="empty-state" style={{ padding: "18px 8px" }}>
      <p className="small">{message}</p>
    </div>
  );
}

// ── Contributor row — three forms: human bound / human unbound / service ──

function ContributorRow({ contributor }: { contributor: PrincipalRef }) {
  const isHuman = contributor.kind === "human";
  const isBound = isHuman && contributor.githubLogin;
  const label = contributor.displayName ?? contributor.principalId;
  const sub = isBound
    ? "GitHub account"
    : isHuman
      ? "Unbound human contributor"
      : contributor.provider;

  const body = (
    <>
      <span className={cn("avatar", contributor.kind === "service" ? "service" : "human")}>
        {isBound && contributor.avatarUrl ? (
          <img
            src={contributor.avatarUrl}
            alt={label}
            className="w-full h-full rounded-full object-cover"
            loading="lazy"
          />
        ) : isHuman ? (
          <svg
            viewBox="0 0 24 24"
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" />
          </svg>
        ) : (
          <Bot className="w-3 h-3" />
        )}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center gap-1.5" style={{ fontWeight: 500 }}>
          {label}
          {isBound && (
            <span className="small muted" title="Bound to a GitHub account">
              @{contributor.githubLogin}
            </span>
          )}
        </div>
        <div className="small muted">{sub}</div>
      </div>
    </>
  );

  if (isBound && contributor.githubLogin) {
    return (
      <a
        href={`https://github.com/${contributor.githubLogin}`}
        target="_blank"
        rel="noopener noreferrer"
        className="contrib-row"
      >
        {body}
        <Github className="w-3.5 h-3.5 text-muted-foreground" />
      </a>
    );
  }

  return <div className="contrib-row">{body}</div>;
}

// ── Skeleton ──

function ConceptDetailSkeleton() {
  return (
    <div className="content wide">
      <Skeleton className="h-5 w-24 mb-[14px]" />
      <div className="c-head">
        <Skeleton className="h-[22px] w-[180px]" />
        <Skeleton className="h-[30px] w-[64%]" />
        <Skeleton className="h-[20px] w-[46%]" />
      </div>
      <div className="concept-grid">
        <div className="card">
          <div className="card-body" style={{ padding: "26px 30px" }}>
            <Skeleton className="h-[18px] w-[30%] mb-[14px]" />
            <Skeleton className="h-[12px] w-full mb-[8px]" />
            <Skeleton className="h-[12px] w-[96%] mb-[8px]" />
            <Skeleton className="h-[12px] w-[88%] mb-[22px]" />
            <Skeleton className="h-[18px] w-[24%] mb-[14px]" />
            <Skeleton className="h-[12px] w-full mb-[8px]" />
            <Skeleton className="h-[12px] w-[92%] mb-[8px]" />
            <Skeleton className="h-[12px] w-[70%]" />
          </div>
        </div>
        <div className="rail">
          <div className="card">
            <div className="card-body" style={{ padding: "16px" }}>
              <Skeleton className="h-[14px] w-[90px] mb-[14px]" />
              <Skeleton
                className="h-[64px] mb-[10px]"
                style={{ borderRadius: "8px" }}
              />
              <Skeleton
                className="h-[64px]"
                style={{ borderRadius: "8px" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
