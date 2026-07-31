import { useState, useEffect } from "react";
import {
  Plus,
  Trash2,
  AlertTriangle,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { DangerConfirmDialog } from "@/components/ui/danger-confirm-dialog";
import { PermissionDenied, ViewerInfoBanner } from "@/components/ui/permission-denied";
import { Users } from "lucide-react";
import type { MyTeam } from "@teamem/schema";
import { useSession } from "@/lib/session";

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

// ── Main page ───────────────────────────────────────────────────────────────

export function SettingsTeamPage() {
  const session = useSession();
  const role = session.role ?? "viewer";
  const isOwner = role === "owner";
  const isViewer: boolean = role === "viewer";

  const [teams, setTeams] = useState<MyTeam[]>([]);
  const [currentTeam, setCurrentTeam] = useState<MyTeam | null>(null);
  const [loading, setLoading] = useState(true);

  // Team edit state
  const [teamName, setTeamName] = useState("");
  const [saving, setSaving] = useState(false);

  // New team state
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [creating, setCreating] = useState(false);

  // Delete state
  const [showDelete, setShowDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Fetch teams
  const refreshTeams = async () => {
    setLoading(true);
    try {
      const data = await fetchJson<MyTeam[]>(`/v1/teams/mine`);
      setTeams(data);
      // Current team — use the first one for now (placeholder for real scope)
      const first = data[0];
      if (first) {
        setCurrentTeam(first);
        setTeamName(first.name);
      }
    } catch {
      setTeams([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshTeams();
  }, []);

  // Rename team
  const handleRename = async () => {
    if (!currentTeam || !teamName.trim()) return;
    setSaving(true);
    try {
      await fetchJson(`/v1/teams/${currentTeam.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: teamName.trim() }),
      });
      setCurrentTeam({ ...currentTeam, name: teamName.trim() });
    } catch {
      // Silently handle
    } finally {
      setSaving(false);
    }
  };

  // Create team
  const handleCreate = async () => {
    if (!newTeamName.trim()) return;
    setCreating(true);
    try {
      await fetchJson(`/v1/teams`, {
        method: "POST",
        body: JSON.stringify({ name: newTeamName.trim() }),
      });
      setShowNewTeam(false);
      setNewTeamName("");
      await refreshTeams();
    } catch {
      // Silently handle
    } finally {
      setCreating(false);
    }
  };

  // Delete team
  const handleDelete = async () => {
    if (!currentTeam) return;
    setDeleteError(null);
    try {
      await fetchJson(`/v1/teams/${currentTeam.id}/delete`, {
        method: "POST",
      });
      setShowDelete(false);
      await refreshTeams();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  // ── Viewer guard ──────────────────────────────────────────────────────
  if (isViewer) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>Team</h1>
            <p className="sub">
              Manage your team configuration and settings.
            </p>
          </div>
        </div>
        <ViewerInfoBanner />
        <PermissionDenied requiredRole="admin" />
      </div>
    );
  }

  return (
    <div className="content narrow px-0">
      <div className="page-head">
        <div className="ph-text">
          <h1>Team</h1>
          <p className="sub">
            Manage your team configuration and settings.
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
          {/* ── Team name ────────────────────────────────────────────── */}
          {currentTeam && (
            <div className="card">
              <div className="card-head">
                <h3>Team</h3>
              </div>
              <div className="card-body">
                <div className="field">
                  <label className="label" htmlFor="tname">
                    Team name
                  </label>
                  <div className="flex gap-2 max-w-[420px]">
                    <input
                      id="tname"
                      className="input"
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      disabled={!isOwner}
                    />
                    {isOwner && (
                      <button
                        className="btn btn-outline"
                        onClick={handleRename}
                        disabled={
                          saving || teamName === currentTeam.name
                        }
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="field mb-0">
                  <label className="label">Teams on this portal</label>
                  <div className="flex flex-wrap gap-2 items-center">
                    {teams.map((t) => (
                      <span
                        key={t.id}
                        className={cn(
                          "pill",
                          t.id === currentTeam.id &&
                            "pill violet"
                        )}
                      >
                        {t.id === currentTeam.id && (
                          <Check className="w-3 h-3" />
                        )}
                        {t.name}
                      </span>
                    ))}
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        setShowNewTeam(true);
                        setNewTeamName("");
                      }}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      New team
                    </button>
                  </div>
                  <p className="hint">
                    You can belong to multiple teams — data is fully isolated
                    between them. Switch teams from the top bar.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Danger zone ──────────────────────────────────────────── */}
          {isOwner && currentTeam && (
            <div className="card" style={{ borderColor: "var(--red)" }}>
              <div className="card-head">
                <h3 style={{ color: "var(--red)" }}>Danger zone</h3>
              </div>
              <div className="card-body">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <strong className="text-[13.5px]">
                      Delete this team
                    </strong>
                    <p className="text-[12.5px] text-text-2 mt-1 leading-relaxed max-w-[480px]">
                      Delete <strong>{currentTeam.name}</strong> and everything
                      in it — all projects, knowledge, events, keys and
                      memberships, for everyone. This cannot be undone.{" "}
                      <span className="text-text-3">Owner only.</span>
                    </p>
                  </div>
                  <button
                    className="btn btn-danger-outline"
                    onClick={() => setShowDelete(true)}
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete team…
                  </button>
                </div>
                {deleteError && (
                  <div className="banner error mt-3">
                    <AlertTriangle className="w-4 h-4" />
                    <div>{deleteError}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {!isOwner && currentTeam && (
            <div className="card" style={{ borderColor: "var(--red)" }}>
              <div className="card-head">
                <h3 style={{ color: "var(--red)" }}>Danger zone</h3>
              </div>
              <div className="card-body">
                <p className="text-[13px] text-text-2">
                  Team deletion is restricted to owners. Contact your team owner
                  if you need to delete this team.
                </p>
              </div>
            </div>
          )}

          {!currentTeam && !loading && (
            <div className="card">
              <EmptyState
                icon={Users}
                title="No teams yet"
                description="Create your first team to get started."
                actions={
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setShowNewTeam(true);
                      setNewTeamName("");
                    }}
                  >
                    <Plus className="w-4 h-4" />
                    Create team
                  </button>
                }
              />
            </div>
          )}
        </div>
      )}

      {/* ── New team modal ───────────────────────────────────────────── */}
      {showNewTeam && (
        <div
          className="modal-veil"
          onClick={() => setShowNewTeam(false)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h3>New team</h3>
                <p className="text-[13px] text-text-2 mt-1">
                  Create a new team — you&apos;ll be the owner.
                </p>
              </div>
              <button
                className="modal-x"
                onClick={() => setShowNewTeam(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="field mb-0">
                <label className="label" htmlFor="ntname">
                  Team name
                </label>
                <input
                  id="ntname"
                  className="input"
                  placeholder="e.g. Acme Corp"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn btn-ghost"
                onClick={() => setShowNewTeam(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={creating || !newTeamName.trim()}
              >
                {creating ? "Creating…" : "Create team"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete team confirmation ─────────────────────────────────── */}
      <DangerConfirmDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        title={`Delete team "${currentTeam?.name}"?`}
        description={`This deletes the team and everything in it, for all members. This cannot be undone.`}
        confirmLabel="Delete team"
        confirmTarget={currentTeam?.name}
        onConfirm={handleDelete}
        level="type-name"
      />
    </div>
  );
}
