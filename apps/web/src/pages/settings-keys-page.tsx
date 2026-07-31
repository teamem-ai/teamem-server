import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Copy,
  Check,
  RotateCw,
  X,
  Key,
  AlertTriangle,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/session";
import { EmptyState } from "@/components/ui/empty-state";
import { KeyReveal, CommandBlock } from "@/components/ui/command-block";
import { DangerConfirmDialog } from "@/components/ui/danger-confirm-dialog";
import { PermissionDenied, ViewerInfoBanner } from "@/components/ui/permission-denied";
import type {
  KeyEntry,
  MintKeyResponse,
  ApiScope,
  ProjectEntry,
} from "@teamem/schema";

// ── Inline fetch helpers (consume public HTTP API only) ──────────────────

const BASE = ""; // Vite proxies /v1 → server

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body?.error?.message ?? `Request failed with status ${res.status}`
    );
  }
  const json = await res.json();
  return json.data as T;
}

// ── Scope display helpers ──────────────────────────────────────────────────

const SCOPE_LABELS: Record<ApiScope, { label: string; desc: string }> = {
  read: { label: "read", desc: "Search and read pages" },
  "read:payload": { label: "read:payload", desc: "Includes read, plus event payloads (audited)" },
  "events:write": { label: "write", desc: "Ingest events (CLI / MCP)" },
  "audit:read": { label: "audit:read", desc: "Read audit log records" },
};

// ── Hook: fetch keys list ──────────────────────────────────────────────────

function useKeys(teamId: string | null) {
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<KeyEntry[]>(`/v1/teams/${teamId}/keys`);
      setKeys(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { keys, loading, error, refresh };
}

// ── Hook: fetch projects ───────────────────────────────────────────────────

function useProjects(teamId: string | null) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!teamId) return;
    setLoading(true);
    fetchJson<ProjectEntry[]>(`/v1/teams/${teamId}/projects`)
      .then(setProjects)
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, [teamId]);

  return { projects, loading };
}

// ── Scope checkbox group ───────────────────────────────────────────────────

function ScopeSelector({
  selected,
  onChange,
}: {
  selected: ApiScope[];
  onChange: (scopes: ApiScope[]) => void;
}) {
  const toggle = (scope: ApiScope) => {
    if (selected.includes(scope)) {
      // Must keep at least one scope
      if (selected.length <= 1) return;
      // If removing read, also remove read:payload
      if (scope === "read") {
        onChange(selected.filter((s) => s !== "read" && s !== "read:payload"));
      } else {
        onChange(selected.filter((s) => s !== scope));
      }
    } else {
      // Adding read:payload requires read
      if (scope === "read:payload" && !selected.includes("read")) {
        onChange([...selected, "read", "read:payload"]);
      } else {
        onChange([...selected, scope]);
      }
    }
  };

  return (
    <div className="space-y-2">
      {(Object.entries(SCOPE_LABELS) as [ApiScope, { label: string; desc: string }][]).map(
        ([scope, { label, desc }]) => (
          <label
            key={scope}
            className="flex items-start gap-[9px] cursor-pointer text-[13.5px]"
          >
            <input
              type="checkbox"
              className="w-4 h-4 mt-px accent-accent"
              checked={selected.includes(scope)}
              onChange={() => toggle(scope)}
            />
            <span>
              <code className="text-[12.5px] font-medium">{label}</code>{" "}
              <span className="text-text-3">— {desc}</span>
            </span>
          </label>
        )
      )}
    </div>
  );
}

// ── Main page component ─────────────────────────────────────────────────────

export function SettingsKeysPage() {
  const session = useSession();
  const teamId = session.teamId;
  const role = session.role ?? "viewer";
  const canManage = role === "owner" || role === "admin";
  const isViewer: boolean = role === "viewer";

  const { keys, loading, error, refresh } = useKeys(teamId);
  const { projects } = useProjects(teamId);

  const [showMint, setShowMint] = useState(false);
  const [minted, setMinted] = useState<MintKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<KeyEntry | null>(null);
  const [rotateTarget, setRotateTarget] = useState<KeyEntry | null>(null);
  const [rotated, setRotated] = useState<MintKeyResponse | null>(null);

  // Mint form state
  const [mintName, setMintName] = useState("");
  const [mintProjectId, setMintProjectId] = useState("");
  const [mintAllProjects, setMintAllProjects] = useState(false);
  const [mintScopes, setMintScopes] = useState<ApiScope[]>(["read"]);
  const [mintError, setMintError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  // ── Mint handler ──────────────────────────────────────────────────────
  const handleMint = async () => {
    if (!mintName.trim()) {
      setMintError("Name is required");
      return;
    }
    setMinting(true);
    setMintError(null);
    try {
      const data = await fetchJson<MintKeyResponse>(
        `/v1/teams/${teamId}/keys`,
        {
          method: "POST",
          body: JSON.stringify({
            name: mintName.trim(),
            projectId: mintAllProjects ? undefined : mintProjectId || undefined,
            allProjects: mintAllProjects,
            scopes: mintScopes,
          }),
        }
      );
      setMinted(data);
      setShowMint(false);
      void refresh();
    } catch (err) {
      setMintError(err instanceof Error ? err.message : "Mint failed");
    } finally {
      setMinting(false);
    }
  };

  // ── Revoke handler ────────────────────────────────────────────────────
  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await fetchJson(`/v1/teams/${teamId}/keys/${revokeTarget.id}/revoke`, {
        method: "POST",
      });
      setRevokeTarget(null);
      void refresh();
    } catch {
      // Silently handle — the key list will reflect the truth on next refresh
    }
  };

  // ── Rotate handler ────────────────────────────────────────────────────
  const doRotate = async () => {
    if (!rotateTarget) return;
    try {
      const data = await fetchJson<MintKeyResponse>(
        `/v1/teams/${teamId}/keys/${rotateTarget.id}/rotate`,
        { method: "POST" }
      );
      setRotated(data);
      setRotateTarget(null);
      void refresh();
    } catch {
      // Silently handle
    }
  };

  // ── Reset mint form ───────────────────────────────────────────────────
  const resetMint = () => {
    setShowMint(false);
    setMinted(null);
    setRotated(null);
    setMintName("");
    setMintProjectId("");
    setMintAllProjects(false);
    setMintScopes(["read"]);
    setMintError(null);
  };

  // ── Viewer guard ──────────────────────────────────────────────────────
  if (isViewer) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>API keys</h1>
            <p className="sub">
              Credentials for agents and the CLI. Keys carry data-plane scopes
              only — they can never administer the portal.
            </p>
          </div>
        </div>
        <ViewerInfoBanner />
        <PermissionDenied requiredRole="admin" />
      </div>
    );
  }

  return (
    <div>
      {/* ── Page header ────────────────────────────────────────────── */}
      <div className="page-head">
        <div className="ph-text">
          <h1>API keys</h1>
          <p className="sub">
            Credentials for agents and the CLI. Keys carry data-plane scopes
            only — they can never administer the portal.
          </p>
        </div>
        {canManage && (
          <div className="ph-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                resetMint();
                setShowMint(true);
              }}
            >
              <Plus className="w-4 h-4" />
              Mint API key
            </button>
          </div>
        )}
      </div>

      {/* ── Error state ────────────────────────────────────────────── */}
      {error && (
        <div className="banner error mb-4">
          <AlertTriangle className="w-4 h-4" />
          <div>
            <span className="font-semibold">Failed to load keys.</span> {error}
          </div>
        </div>
      )}

      {/* ── List / loading / empty ──────────────────────────────────── */}
      {loading ? (
        <div className="card py-5 px-5 space-y-3">
          <div className="skeleton h-5 w-1/3" />
          <div className="skeleton h-4 w-1/2" />
          <div className="skeleton h-4 w-2/3" />
        </div>
      ) : keys.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Key}
            title="No keys minted yet"
            description="Mint one to connect an agent or run teamem init."
            actions={
              canManage && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    resetMint();
                    setShowMint(true);
                  }}
                >
                  <Plus className="w-4 h-4" />
                  Mint your first key
                </button>
              )
            }
          />
        </div>
      ) : (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 150 }}>Key ID</th>
                <th style={{ width: 170 }}>Scopes</th>
                <th style={{ width: 120 }}>Project</th>
                <th style={{ width: 110 }}>Created</th>
                <th style={{ width: 95 }}>Status</th>
                {canManage && <th style={{ width: 170 }} />}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr
                  key={key.id}
                  className={cn(key.revoked && "opacity-55")}
                >
                  <td>
                    <strong className={cn(key.revoked && "line-through")}>
                      {key.name}
                    </strong>
                  </td>
                  <td>
                    <CopyChip text={key.id} />
                  </td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {key.scopes.map((s: string) => (
                        <span key={s} className="scope-tag">
                          {(SCOPE_LABELS as Record<string, { label: string; desc: string }>)[s]?.label ?? s}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="text-text-2">
                    {key.allProjects
                      ? "All projects"
                      : key.projectName ?? key.projectId ?? "—"}
                  </td>
                  <td className="text-text-3 text-xs">
                    {new Date(key.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td>
                    {key.revoked ? (
                      <span className="pill">Revoked</span>
                    ) : (
                      <span className="pill green">Active</span>
                    )}
                  </td>
                  {canManage && (
                    <td>
                      {!key.revoked && (
                        <span className="flex gap-0.5">
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Rotate: mint new + revoke this one immediately"
                            onClick={() => setRotateTarget(key)}
                          >
                            <RotateCw className="w-3.5 h-3.5" />
                            Rotate
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ color: "var(--red)" }}
                            onClick={() => setRevokeTarget(key)}
                          >
                            Revoke
                          </button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-text-3 mt-2.5">
        Key IDs (<code className="text-[11px]">key_…</code>) are identifiers,
        safe to display. The secret token (<code className="text-[11px]">tm_…</code>)
        is shown once at minting — we store only its hash.
      </p>

      {/* ── Mint modal ──────────────────────────────────────────────── */}
      {showMint && (
        <ModalVeil onClose={resetMint}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div>
                <h3>Mint API key</h3>
                <p className="text-[13px] text-text-2 mt-1">
                  The secret is shown once, right after minting.
                </p>
              </div>
              <button className="modal-x" onClick={resetMint} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="modal-body space-y-4">
              <div className="field">
                <label className="label" htmlFor="kname">
                  Name
                </label>
                <input
                  id="kname"
                  className="input"
                  placeholder='e.g. "claude-code-laptop" or "ci-readonly"'
                  value={mintName}
                  onChange={(e) => setMintName(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="kproj">
                  Project
                </label>
                <select
                  id="kproj"
                  className="select"
                  value={mintProjectId}
                  onChange={(e) => setMintProjectId(e.target.value)}
                  disabled={mintAllProjects}
                >
                  <option value="">Select a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <label className="flex items-start gap-[9px] cursor-pointer text-[13.5px] mt-2">
                  <input
                    type="checkbox"
                    className="w-4 h-4 mt-px accent-accent"
                    checked={mintAllProjects}
                    onChange={(e) => {
                      setMintAllProjects(e.target.checked);
                      if (e.target.checked) setMintProjectId("");
                    }}
                  />
                  <span>
                    All projects{" "}
                    <span className="text-text-3">(team-level key)</span>
                  </span>
                </label>
              </div>
              <div className="field mb-0">
                <label className="label">Scopes</label>
                <ScopeSelector
                  selected={mintScopes}
                  onChange={setMintScopes}
                />
                <p className="hint">
                  Keys never carry admin rights — they can&apos;t manage members,
                  settings or other keys.
                </p>
              </div>
              {mintError && (
                <div className="banner error">
                  <AlertTriangle className="w-4 h-4" />
                  <div>{mintError}</div>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={resetMint}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleMint}
                disabled={
                  minting ||
                  !mintName.trim() ||
                  (!mintAllProjects && !mintProjectId)
                }
              >
                {minting ? "Minting…" : "Mint key"}
              </button>
            </div>
          </div>
        </ModalVeil>
      )}

      {/* ── Minted (one-time plaintext) modal ──────────────────────── */}
      {minted && (
        <ModalVeil onClose={resetMint}>
          <div className="modal wide" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div>
                <h3>Key minted</h3>
                <p className="text-[13px] text-text-2 mt-1">
                  <strong>{minted.name}</strong> · {minted.id}
                  {minted.allProjects
                    ? " · All projects"
                    : minted.projectId
                      ? ` · ${minted.projectId}`
                      : ""}{" "}
                  · {minted.scopes.map((s: string) => SCOPE_LABELS[s as ApiScope]?.label ?? s).join(", ")}
                </p>
              </div>
            </div>
            <div className="modal-body space-y-3">
              <KeyReveal token={minted.token} />
              <div className="banner warn">
                <ShieldAlert className="w-4 h-4" />
                <div>
                  <span className="font-semibold">
                    Copy it now — you won&apos;t see this key again.
                  </span>{" "}
                  We store only a hash.
                </div>
              </div>
              {minted.mcpCommand && (
                <CommandBlock
                  command={minted.mcpCommand}
                  description="Plug team knowledge into Claude Code with this key:"
                />
              )}
            </div>
            <div className="modal-foot">
              <button className="btn btn-primary" onClick={resetMint}>
                Done — I&apos;ve saved the key
              </button>
            </div>
          </div>
        </ModalVeil>
      )}

      {/* ── Rotated (one-time plaintext) modal ─────────────────────── */}
      {rotated && (
        <ModalVeil onClose={resetMint}>
          <div className="modal wide" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div>
                <h3>Key rotated</h3>
                <p className="text-[13px] text-text-2 mt-1">
                  <strong>{rotated.name}</strong> · {rotated.id}
                </p>
              </div>
            </div>
            <div className="modal-body space-y-3">
              <KeyReveal token={rotated.token} />
              <div className="banner warn">
                <ShieldAlert className="w-4 h-4" />
                <div>
                  <span className="font-semibold">
                    Copy it now — you won&apos;t see this key again.
                  </span>{" "}
                  We store only a hash. The old key has been revoked immediately.
                </div>
              </div>
              {rotated.mcpCommand && (
                <CommandBlock
                  command={rotated.mcpCommand}
                  description="Update your Claude Code connection:"
                />
              )}
            </div>
            <div className="modal-foot">
              <button className="btn btn-primary" onClick={resetMint}>
                Done — I&apos;ve saved the key
              </button>
            </div>
          </div>
        </ModalVeil>
      )}

      {/* ── Rotate confirmation ────────────────────────────────────── */}
      <DangerConfirmDialog
        open={!!rotateTarget}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null);
        }}
        title={`Rotate "${rotateTarget?.name}"?`}
        description={`Rotating mints a new key and revokes the old one immediately. Anything still using the old key will stop working.`}
        confirmLabel="Rotate now"
        onConfirm={doRotate}
        level="normal"
      />

      {/* ── Revoke confirmation ────────────────────────────────────── */}
      <DangerConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={`Revoke "${revokeTarget?.name}"?`}
        description={`Requests using this key will fail immediately with 401. This can't be undone — but you can mint a replacement anytime.`}
        confirmLabel="Revoke now"
        onConfirm={handleRevoke}
        level="normal"
      />
    </div>
  );
}

// ── Helper components ───────────────────────────────────────────────────────

/** Click-to-copy chip for key IDs. Safe to display — never the secret. */
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      className="copy-chip"
      onClick={handleCopy}
      title="Key ID — not the secret, safe to display"
    >
      {text.slice(0, 16)}…
      {copied ? (
        <Check className="w-3 h-3" />
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  );
}

/** Modal backdrop + centering wrapper. */
function ModalVeil({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-veil" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
