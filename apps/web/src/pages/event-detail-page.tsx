/**
 * Event detail page — D2 in DESIGN.md §7–§8.
 *
 * Displays event metadata + redacted payload viewer with audit notice.
 * Fail-closed: if the audit write fails server-side, the payload is
 * blocked and a lock state is shown (AuditWriteFailedError).
 * Consumes GET /v1/events/:id (requires read:payload scope, audited).
 */
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  ShieldCheck,
  Lock,
  Info,
  GitCommitHorizontal,
  GitPullRequest,
  CircleDot,
  MessageSquare,
  Terminal,
  Sparkles,
  Activity,
} from "lucide-react";
import type { EventDetail, ActorProvenance } from "@teamem/schema";
import {
  fetchEventDetail,
  AuditWriteFailedError,
  ApiError,
} from "@/lib/api";
import { ProjectScopePrompt } from "@/components/ui/project-scope-prompt";
import { useProjectId } from "@/lib/use-project-id";

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

function actorInitials(displayLogin?: string): string {
  if (!displayLogin) return "?";
  return displayLogin.slice(0, 2).toUpperCase();
}

const sourceKindIcon: Record<string, typeof GitCommitHorizontal> = {
  github_commit: GitCommitHorizontal,
  github_pr: GitPullRequest,
  github_issue: CircleDot,
  github_pr_comment: MessageSquare,
  cli_init: Terminal,
  mcp_write: Sparkles,
  external_event: Activity,
};

// ── JSON syntax highlighting (safe, no dangerouslySetInnerHTML) ──────────

function JsonString({ children }: { children: string }) {
  return (
    <span className="json-string">
      {JSON.stringify(children)}
    </span>
  );
}

function JsonValue({ value, indent = 0 }: { value: unknown; indent?: number }) {
  const pad = "  ".repeat(indent);

  if (value === null) {
    return <span className="json-null">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-bool">{value ? "true" : "false"}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-number">{String(value)}</span>;
  }
  if (typeof value === "string") {
    return <JsonString>{value}</JsonString>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span>[]</span>;
    }
    return (
      <span>
        {"["}
        {value.map((item, index) => (
          <span key={index}>
            {"\n"}{pad}{"  "}
            <JsonValue value={item} indent={indent + 1} />
            {index < value.length - 1 ? "," : ""}
          </span>
        ))}
        {"\n"}{pad}{"]"}
      </span>
    );
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return <span>{"{}"}</span>;
    }
    return (
      <span>
        {"{"}
        {keys.map((key, index) => (
          <span key={key}>
            {"\n"}{pad}{"  "}
            <span className="json-key">{JSON.stringify(key)}</span>
            {": "}
            <JsonValue value={obj[key]} indent={indent + 1} />
            {index < keys.length - 1 ? "," : ""}
          </span>
        ))}
        {"\n"}{pad}{"}"}
      </span>
    );
  }
  return <span>{JSON.stringify(value)}</span>;
}

function JsonViewer({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="json-viewer">
      <JsonValue value={data} />
    </pre>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ActorDisplay({
  actor,
  provenance,
}: {
  actor: EventDetail["actor"];
  provenance: ActorProvenance;
}) {
  const isVerified = provenance === "webhook_verified";
  const hasActor = actor !== null;

  if (!hasActor) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="avatar unknown w-[22px] h-[22px] text-[9px]">?</span>
        <span className="text-text-3">Unknown</span>
      </span>
    );
  }

  const displayLogin = actor.displayLogin;

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="avatar w-[22px] h-[22px] text-[9px]"
        style={{ background: "var(--emerald)" }}
      >
        {actorInitials(displayLogin)}
      </span>
      <span>{displayLogin ?? "Unknown"}</span>
      {isVerified && (
        <>
          <ShieldCheck
            className="w-[13px] h-[13px]"
            style={{ color: "var(--green)" }}
            aria-label="Identity verified by GitHub webhook signature"
          />
          <span className="text-[12.5px] text-text-3">webhook_verified</span>
        </>
      )}
    </span>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { projectId, setProjectId, isReady: scopeReady } = useProjectId();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Audit-write failure → fail-closed lock state (distinct from generic errors). */
  const [auditFailed, setAuditFailed] = useState(false);
  const [auditRequestId, setAuditRequestId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!id || !projectId || !scopeReady) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setAuditFailed(false);
    setAuditRequestId(null);

    fetchEventDetail(id, projectId)
      .then((result) => {
        if (cancelled) return;
        setEvent(result.data as EventDetail);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AuditWriteFailedError) {
          setAuditFailed(true);
          setAuditRequestId(err.requestId ?? null);
        } else if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Failed to load event detail");
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, projectId, scopeReady]);

  const handleCopyJson = async () => {
    if (!event) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(event.payload, null, 2),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard write failed — silently ignore
    }
  };

  const handleCopyId = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // silent
    }
  };

  const backHref = projectId ? `/events?projectId=${projectId}` : "/events";

  // ── Project scope prompt ────────────────────────────────────────────────
  if (!projectId && scopeReady) {
    return (
      <div className="max-w-[860px]">
        <a className="btn btn-ghost btn-sm" href={backHref} style={{ marginBottom: "14px" }}>
          <ArrowLeft /> Events
        </a>
        <div className="card">
          <ProjectScopePrompt onSet={setProjectId} />
        </div>
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="max-w-[860px]">
        <a className="btn btn-ghost btn-sm" href={backHref} style={{ marginBottom: "14px" }}>
          <ArrowLeft /> Events
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

  // ── Fail-closed lock state (audit unavailable) ────────────────────────────
  if (auditFailed) {
    return (
      <div className="max-w-[860px]">
        <a className="btn btn-ghost btn-sm" href={backHref} style={{ marginBottom: "14px" }}>
          <ArrowLeft /> Events
        </a>
        <div className="card">
          <div className="empty-state" style={{ padding: "48px 24px" }}>
            <div className="e-icon" style={{ color: "var(--red)" }}>
              <Lock />
            </div>
            <h3>Can&apos;t display payload right now</h3>
            <p>
              Audit logging is unavailable, and payload reads are blocked
              until it recovers. This is intentional — reads are never
              allowed to bypass the audit trail.
            </p>
            <div className="e-actions">
              <button
                className="btn btn-outline"
                onClick={() => window.location.reload()}
              >
                Retry
              </button>
              {auditRequestId && (
                <span className="small muted" style={{ alignSelf: "center" }}>
                  Request ID <code className="mono">{auditRequestId}</code>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Generic error ─────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="max-w-[860px]">
        <a className="btn btn-ghost btn-sm" href={backHref} style={{ marginBottom: "14px" }}>
          <ArrowLeft /> Events
        </a>
        <div className="card">
          <div className="empty-state" style={{ padding: "48px 24px" }}>
            <div className="e-icon" style={{ color: "var(--red)" }}>
              <Info />
            </div>
            <h3>Failed to load event</h3>
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
  if (!event) {
    return (
      <div className="max-w-[860px]">
        <a className="btn btn-ghost btn-sm" href={backHref} style={{ marginBottom: "14px" }}>
          <ArrowLeft /> Events
        </a>
        <div className="card">
          <div className="empty-state" style={{ padding: "48px 24px" }}>
            <div className="e-icon">
              <Info />
            </div>
            <h3>Not found</h3>
            <p>
              This event doesn&apos;t exist, or the link is out of date.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Normal display ────────────────────────────────────────────────────────
  return (
    <div className="max-w-[860px]">
      <a className="btn btn-ghost btn-sm" href={backHref} style={{ marginBottom: "14px" }}>
        <ArrowLeft /> Events
      </a>

      <div className="stack">
        {/* Metadata card */}
        <div className="card">
          <div className="card-head">
            <span className="pill">
              {(() => {
                const Icon = sourceKindIcon[event.source.kind] ?? Activity;
                return <Icon />;
              })()}
              {event.source.kind}
            </span>
            <h3>{event.source.externalId || "Event"}</h3>
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>Event ID</dt>
              <dd>
                <button
                  className="copy-chip"
                  onClick={() => handleCopyId(event.id)}
                >
                  {event.id}
                  <Copy />
                </button>
              </dd>
              <dt>Actor</dt>
              <dd>
                <ActorDisplay actor={event.actor} provenance={event.actorProvenance} />
              </dd>
              <dt>Occurred</dt>
              <dd>
                {formatFullDate(event.occurredAt)}{" "}
                <span className="text-text-3 text-[12.5px]">
                  ({formatRelativeTime(event.occurredAt)}) · source time
                </span>
              </dd>
              <dt>Received</dt>
              <dd>{formatFullDate(event.createdAt)}</dd>
              <dt>Project</dt>
              <dd>{event.projectId}</dd>
              <dt>External ID</dt>
              <dd>
                <code className="mono text-[12px]">{event.source.externalId}</code>
              </dd>
            </dl>
          </div>
        </div>

        {/* Audit notice */}
        <div className="banner info">
          <Info className="ic" />
          <div>
            <span className="b-title">
              Payload access is recorded in the audit log.
            </span>
            {" "}This payload was redacted at ingest — private segments were
            removed before storage.
          </div>
        </div>

        {/* Payload card */}
        <div className="card">
          <div className="card-head">
            <h3>
              Payload <span className="text-text-3 text-[12.5px] font-normal">redacted at ingest</span>
            </h3>
            <div className="ch-actions">
              <button
                className="btn btn-sm btn-outline"
                onClick={handleCopyJson}
              >
                <Copy />
                {copied ? "Copied" : "Copy JSON"}
              </button>
            </div>
          </div>
          <div
            className="card-body"
            style={{ background: "var(--surface-2)", borderRadius: "0 0 var(--r-lg) var(--r-lg)" }}
          >
            <JsonViewer data={event.payload} />
          </div>
        </div>
      </div>
    </div>
  );
}
