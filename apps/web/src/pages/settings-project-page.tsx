import { useState, useEffect } from "react";
import {
  Copy,
  Check,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { DangerConfirmDialog } from "@/components/ui/danger-confirm-dialog";
import { PermissionDenied, ViewerInfoBanner } from "@/components/ui/permission-denied";
import { SoonBadge } from "@/components/ui/soon-badge";
import type { ProjectEntry } from "@teamem/schema";

// ── Inline fetch helpers ────────────────────────────────────────────────────

const BASE = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed with status ${res.status}`);
  }
  const json = await res.json();
  return json.data as T;
}

// ── Purge response type ─────────────────────────────────────────────────────

interface PurgeResponse {
  requestId: string;
  projectId: string;
  eventsDeleted: number;
  conceptsDeleted: number;
  jobsDeleted: number;
}

// ── Main page ───────────────────────────────────────────────────────────────

export function SettingsProjectPage() {
  const teamId = "team_demo"; // placeholder
  const role: string = "owner"; // placeholder
  const canManage = role === "owner" || role === "admin";
  const isOwner = role === "owner";
  const isViewer: boolean = role === "viewer";

  // Project data
  const [project, setProject] = useState<ProjectEntry | null>(null);
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Purge state
  const [showPurge, setShowPurge] = useState(false);
  const [purged, setPurged] = useState<PurgeResponse | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  // Fetch project
  useEffect(() => {
    if (!canManage) return;
    setLoading(true);
    fetchJson<ProjectEntry[]>(`/v1/teams/${teamId}/projects`)
      .then((projects) => {
        const first = projects[0];
        if (first) {
          setProject(first);
          setProjectName(first.name);
        }
      })
      .catch(() => setProject(null))
      .finally(() => setLoading(false));
  }, [teamId, canManage]);

  // Rename
  const handleRename = async () => {
    if (!project || !projectName.trim()) return;
    setSaving(true);
    try {
      const updated = await fetchJson<ProjectEntry>(
        `/v1/teams/${teamId}/projects/${project.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: projectName.trim() }),
        }
      );
      setProject(updated);
    } catch {
      // Silently handle
    } finally {
      setSaving(false);
    }
  };

  // Purge
  const handlePurge = async () => {
    if (!project) return;
    setPurging(true);
    setPurgeError(null);
    try {
      const result = await fetchJson<PurgeResponse>(
        `/teams/${teamId}/projects/${project.id}/purge`,
        { method: "POST" }
      );
      setPurged(result);
      setShowPurge(false);
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : "Purge failed");
    } finally {
      setPurging(false);
    }
  };

  // ── Viewer guard ──────────────────────────────────────────────────────
  if (isViewer) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>Project</h1>
            <p className="sub">
              General settings and danger zone for the current project.
            </p>
          </div>
        </div>
        <ViewerInfoBanner />
        <PermissionDenied requiredRole="admin" />
      </div>
    );
  }

  // ── Purged result ─────────────────────────────────────────────────────
  if (purged) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>Project</h1>
          </div>
        </div>
        <div className="card">
          <div className="empty" style={{ padding: "56px 24px" }}>
            <div
              className="e-icon"
              style={{ color: "var(--green)", background: "var(--green-soft)" }}
            >
              <Check className="w-[22px] h-[22px]" />
            </div>
            <h3>Project purged</h3>
            <p style={{ marginTop: 4 }}>
              <strong>{purged.eventsDeleted}</strong> events,{" "}
              <strong>{purged.conceptsDeleted}</strong> pages and{" "}
              <strong>{purged.jobsDeleted}</strong> jobs were removed from{" "}
              <strong>{project?.name ?? purged.projectId}</strong>.
            </p>
            <p className="text-xs text-text-3" style={{ marginTop: 8 }}>
              Audit records and member identities were retained — the purge
              itself is logged in the audit trail.
            </p>
            <div className="e-actions">
              <a className="btn btn-outline" href="/audit">
                View audit log
              </a>
              <a className="btn btn-primary" href="/knowledge">
                Back to Knowledge
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="content narrow px-0">
      <div className="page-head">
        <div className="ph-text">
          <h1>Project</h1>
          <p className="sub">
            General settings and danger zone for the current project.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="stack">
          <div className="card card-body">
            <div className="skeleton h-5 w-1/3 mb-3" />
            <div className="skeleton h-4 w-2/3" />
          </div>
        </div>
      ) : (
        <div className="stack">
          {/* ── General ──────────────────────────────────────────────── */}
          <div className="card">
            <div className="card-head">
              <h3>General</h3>
            </div>
            <div className="card-body">
              <div className="field">
                <label className="label" htmlFor="pname">
                  Project name
                </label>
                <div className="flex gap-2 max-w-[420px]">
                  <input
                    id="pname"
                    className="input"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    disabled={!canManage}
                  />
                  <button
                    className="btn btn-outline"
                    onClick={handleRename}
                    disabled={saving || !canManage || projectName === project?.name}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              <div className="field mb-0">
                <label className="label">Project ID</label>
                <div>
                  <CopyChip text={project?.id ?? "—"} />
                </div>
                <p className="hint">
                  Used in API calls and CLI commands.
                </p>
              </div>
            </div>
          </div>

          {/* ── Staleness detection (SOON placeholder) ────────────────── */}
          <div className="card">
            <div className="card-head">
              <h3>
                Staleness detection{" "}
                <SoonBadge className="inline-flex ml-1.5" />
              </h3>
            </div>
            <div className="card-body">
              <div className="flex items-start gap-3">
                <span
                  className="switch disabled"
                  role="switch"
                  aria-checked="false"
                  aria-disabled="true"
                  title="Coming in V1.5"
                />
                <div className="text-[13px] text-text-2 flex-1 leading-relaxed">
                  Flag pages whose referenced code has changed since the evidence
                  was written — &ldquo;this knowledge may be outdated&rdquo;.{" "}
                  <span className="text-text-3">Coming in V1.5.</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── Danger zone ──────────────────────────────────────────── */}
          {isOwner && (
            <div className="card" style={{ borderColor: "var(--red)" }}>
              <div className="card-head">
                <h3 style={{ color: "var(--red)" }}>Danger zone</h3>
              </div>
              <div className="card-body">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <strong className="text-[13.5px]">
                      Purge project data
                    </strong>
                    <p className="text-[12.5px] text-text-2 mt-1 leading-relaxed max-w-[480px]">
                      Delete all events, pages and jobs in{" "}
                      <strong>{project?.name ?? "this project"}</strong>. Audit
                      records and member identities are kept. This cannot be
                      undone.{" "}
                      <span className="text-text-3">Owner only.</span>
                    </p>
                  </div>
                  <button
                    className="btn btn-danger-outline"
                    onClick={() => setShowPurge(true)}
                  >
                    <Trash2 className="w-4 h-4" />
                    Purge…
                  </button>
                </div>
                {purgeError && (
                  <div className="banner error mt-3">
                    <AlertTriangle className="w-4 h-4" />
                    <div>{purgeError}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {!isOwner && canManage && (
            <div className="card" style={{ borderColor: "var(--red)" }}>
              <div className="card-head">
                <h3 style={{ color: "var(--red)" }}>Danger zone</h3>
              </div>
              <div className="card-body">
                <p className="text-[13px] text-text-2">
                  Project purge is restricted to team owners. Contact your team
                  owner if you need to delete all project data.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Purge confirmation ───────────────────────────────────────── */}
      <DangerConfirmDialog
        open={showPurge}
        onOpenChange={setShowPurge}
        title="Purge project data?"
        description={`This permanently deletes all events, pages and jobs in ${
          project?.name ?? "this project"
        }. Audit records are kept.`}
        confirmLabel="Purge project data"
        confirmTarget={project?.name}
        onConfirm={handlePurge}
        level="type-name"
      />
    </div>
  );
}

// ── CopyChip helper ─────────────────────────────────────────────────────────

function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-chip"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {text}
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}
