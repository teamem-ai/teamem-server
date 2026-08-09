import { useState, useEffect } from "react";
import { Trash2, AlertTriangle, Users } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { DangerConfirmDialog } from "@/components/ui/danger-confirm-dialog";
import { PermissionDenied, ViewerInfoBanner } from "@/components/ui/permission-denied";
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

  const [currentTeam, setCurrentTeam] = useState<MyTeam | null>(null);
  const [loading, setLoading] = useState(true);

  // Team edit state
  const [teamName, setTeamName] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete state
  const [showDelete, setShowDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Fetch the session's team. This portal is single-team: creating additional
  // teams is deliberately NOT offered here. Team switching is not implemented
  // (the session always resolves to one team), so exposing "new team" would
  // silently strand the user in a team they can't reach — the exact trap that
  // broke Knowledge/Context loading. See tasks/M2 CLOSEOUT §11.
  const refreshTeam = async () => {
    setLoading(true);
    try {
      const data = await fetchJson<MyTeam[]>(`/v1/teams/mine`);
      const first = data[0];
      if (first) {
        setCurrentTeam(first);
        setTeamName(first.name);
      } else {
        setCurrentTeam(null);
      }
    } catch {
      setCurrentTeam(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshTeam();
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

  // Delete team
  const handleDelete = async () => {
    if (!currentTeam) return;
    setDeleteError(null);
    try {
      await fetchJson(`/v1/teams/${currentTeam.id}/delete`, {
        method: "POST",
      });
      setShowDelete(false);
      await refreshTeam();
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
                <div className="field mb-0">
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
                  <p className="hint">
                    This portal uses a single team. All projects, members and
                    knowledge live inside it.
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
                title="No team yet"
                description="You're not in a team yet. Finish setup to create yours."
                actions={
                  <a className="btn btn-primary" href="/onboarding">
                    Go to setup
                  </a>
                }
              />
            </div>
          )}
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
