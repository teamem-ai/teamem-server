import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Users,
  Plus,
  ChevronDown,
  X,
  Copy,
  Check,
  ShieldAlert,
  Info,
} from "lucide-react";
import { RoleBadge, EmptyState, Banner, Skeleton } from "@/components/ui";
import type { Role } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import {
  fetchMembers,
  fetchMe,
  changeMemberRole,
  removeMember,
  createInvite,
  type MemberEntry,
  type SessionInfo,
} from "@/lib/api";

// ── Role radio card descriptions ────────────────────────────────────────────

const ROLE_DESCRIPTIONS: Record<
  Role,
  { label: string; desc: string; isDefault?: boolean }
> = {
  viewer: {
    label: "Viewer",
    desc: "Browse knowledge and job activity, read-only",
  },
  member: {
    label: "Member",
    desc: "Search, read payloads, preview agent context",
    isDefault: true,
  },
  admin: {
    label: "Admin",
    desc: "Manage keys, connectors, LLM settings and audit",
  },
  owner: {
    label: "Owner",
    desc: "Full control, including destructive actions and role management",
  },
};

const ROLES: Role[] = ["viewer", "member", "admin", "owner"];

// ── InviteModal ────────────────────────────────────────────────────────────

function InviteModal({
  teamId,
  open,
  onClose,
  currentUserRole,
}: {
  teamId: string | null;
  open: boolean;
  onClose: () => void;
  /** Current user's role — used to hide owner option from non-owners. */
  currentUserRole: Role | null;
}) {
  const isOwner = currentUserRole === "owner";
  // Roles the current user is allowed to invite for (admins cannot invite as owner).
  const allowedRoles: Role[] = isOwner
    ? ["viewer", "member", "admin", "owner"]
    : ["viewer", "member", "admin"];

  const [selectedRole, setSelectedRole] = useState<Role>("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [targetRole, setTargetRole] = useState<Role>("member");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setSelectedRole("member");
      setInviteLink(null);
      setTargetRole("member");
      setLoading(false);
      setError(null);
      setCopied(false);
    }
  }, [open]);

  const handleCreate = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    setError(null);
    try {
      const invite = await createInvite(teamId, selectedRole);
      setInviteLink(invite.inviteLink);
      setTargetRole(invite.targetRole);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to create invite link");
      }
    } finally {
      setLoading(false);
    }
  }, [teamId, selectedRole]);

  const handleCopy = useCallback(async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text
      const el = document.getElementById("invite-link-text");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  }, [inviteLink]);

  if (!open) return null;

  const isLinkStep = inviteLink !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Veil */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className={cn(
          "relative bg-surface border border-border rounded-xl shadow-lg z-10 w-full max-w-[440px] mx-4",
          "animate-in fade-in slide-in-from-bottom-4 duration-200",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={isLinkStep ? "inv-link-title" : "inv-title"}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-1">
          <div>
            <h3
              id={isLinkStep ? "inv-link-title" : "inv-title"}
              className="text-[15px] font-semibold"
            >
              {isLinkStep ? "Invite link ready" : "Invite member"}
            </h3>
            <p className="text-[13px] text-text-2 mt-0.5 leading-relaxed">
              {isLinkStep
                ? `Share it with your teammate — they join as ${ROLE_DESCRIPTIONS[targetRole].label}.`
                : "Pick a role — you'll get a single-use link to share. They join with GitHub sign-in."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-sm text-text-3 hover:text-text hover:bg-surface-2 transition-colors flex-none"
            aria-label="Close"
          >
            <X className="w-[17px] h-[17px]" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-3">
          {!isLinkStep ? (
            /* Step 1: Role selection */
            <div>
              {allowedRoles.map((role) => (
                <button
                  key={role}
                  className={cn(
                    "role-option",
                    selectedRole === role && "selected",
                  )}
                  onClick={() => setSelectedRole(role)}
                  type="button"
                >
                  <span className="radio-circle" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <RoleBadge role={role} />
                      {ROLE_DESCRIPTIONS[role].isDefault && (
                        <span className="pill text-[10px]">Default</span>
                      )}
                    </div>
                    <p className="role-desc">{ROLE_DESCRIPTIONS[role].desc}</p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            /* Step 2: Link generated */
            <div>
              <div className="cmd-block">
                <code id="invite-link-text">{inviteLink}</code>
                <button
                  className="copy-btn flex-none"
                  onClick={handleCopy}
                  type="button"
                >
                  {copied ? (
                    <>
                      <Check className="w-[13px] h-[13px]" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-[13px] h-[13px]" />
                      Copy
                    </>
                  )}
                </button>
              </div>
              <div className="banner info mt-3">
                <Info className="ic" />
                <div className="text-[12.5px]">
                  Expires in <strong>7 days</strong> ·{" "}
                  <strong>single use</strong>. You can revoke it anytime from
                  this page.
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="banner error mt-3">
              <ShieldAlert className="ic" />
              <div className="text-[12.5px]">{error}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 pb-5 pt-1">
          {!isLinkStep ? (
            <>
              <button className="btn btn-ghost" onClick={onClose} type="button">
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={loading || !teamId}
                type="button"
              >
                {loading ? "Creating…" : "Create invite link"}
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={onClose} type="button">
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── RoleDropdown ────────────────────────────────────────────────────────────

function RoleDropdown({
  currentRole,
  isLastOwner,
  isSelf,
  onChange,
}: {
  currentRole: Role;
  isLastOwner: boolean;
  isSelf: boolean;
  onChange: (role: Role) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click (the menu is portaled to document.body, so it's
  // checked separately from the trigger's own ref).
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !(menuRef.current && menuRef.current.contains(target))
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // The menu is positioned in the viewport (fixed), so a stale position must
  // not survive a scroll/resize — close instead of drifting off the trigger.
  useEffect(() => {
    if (!open) return;
    function handleScrollOrResize() {
      setOpen(false);
    }
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [open]);

  const toggleOpen = useCallback(() => {
    setOpen((wasOpen) => {
      const willOpen = !wasOpen;
      if (willOpen && ref.current) {
        const rect = ref.current.getBoundingClientRect();
        setMenuPos({ top: rect.bottom + 4, left: rect.left });
      }
      return willOpen;
    });
  }, []);

  const handleSelect = useCallback(
    async (role: Role) => {
      setLoading(true);
      try {
        await onChange(role);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    },
    [onChange],
  );

  return (
    <div className="relative" ref={ref}>
      <button
        className="role-dropdown-chip"
        onClick={toggleOpen}
        type="button"
        disabled={loading}
      >
        <RoleBadge role={currentRole} className="!border-0 !bg-transparent !p-0" />
        <ChevronDown className="w-[13px] h-[13px] text-text-3" />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed w-60 bg-surface border border-border rounded-lg shadow-lg z-20 py-1"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          {ROLES.map((role) => {
            const isDisabled =
              isLastOwner && isSelf && role !== "owner";
            return (
              <button
                key={role}
                className={cn(
                  "w-full text-left px-3 py-2 text-[13px] transition-colors",
                  role === currentRole
                    ? "bg-accent-soft text-accent font-semibold"
                    : isDisabled
                      ? "text-text-3 cursor-not-allowed"
                      : "text-text-2 hover:bg-surface-2 hover:text-text",
                )}
                onClick={() => {
                  if (!isDisabled) handleSelect(role);
                }}
                disabled={isDisabled}
                type="button"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full flex-none",
                      role === currentRole ? "bg-accent" : "bg-transparent",
                    )}
                  />
                  <div>
                    <div className="font-medium">
                      {ROLE_DESCRIPTIONS[role].label}
                      {isDisabled && (
                        <span className="text-[11px] text-text-3 ml-1.5">
                          (can&apos;t demote last owner)
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-text-3 mt-0.5">
                      {ROLE_DESCRIPTIONS[role].desc}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── RemoveConfirm ───────────────────────────────────────────────────────────

function RemoveConfirmDialog({
  login,
  onConfirm,
  onCancel,
}: {
  login: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to remove member");
      }
      setLoading(false);
    }
  }, [onConfirm]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={loading ? undefined : onCancel}
        aria-hidden="true"
      />
      <div
        className="relative bg-surface border border-border rounded-xl shadow-lg z-10 w-full max-w-[380px] mx-4 p-5"
        role="alertdialog"
        aria-modal="true"
      >
        <h3 className="text-[15px] font-semibold">Remove {login}?</h3>
        <p className="text-[13px] text-text-2 mt-1.5 leading-relaxed">
          They will lose access to this team. Their past contributions remain
          in the knowledge base.
        </p>

        {error && (
          <div className="banner error mt-3">
            <ShieldAlert className="ic" />
            <div className="text-[12.5px]">{error}</div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={loading}
            type="button"
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            style={{
              background: "var(--red)",
              color: "#fff",
              borderColor: "transparent",
            }}
            onClick={handleConfirm}
            disabled={loading}
            type="button"
          >
            {loading ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MemberAvatar ────────────────────────────────────────────────────────────

function MemberAvatar({
  login,
  avatarUrl,
}: {
  login: string;
  avatarUrl: string | null;
}) {
  const initials = login
    .split(/[.-]/)
    .slice(0, 2)
    .map((p) => (p[0] ?? "").toUpperCase())
    .join("");

  // Generate a deterministic color from the login
  const colors = [
    "var(--accent)",
    "var(--violet)",
    "var(--sky)",
    "var(--emerald)",
    "var(--rose)",
    "var(--amber)",
    "var(--blue)",
  ];
  let hash = 0;
  for (let i = 0; i < login.length; i++) {
    hash = login.charCodeAt(i) + ((hash << 5) - hash);
  }
  const color = colors[Math.abs(hash) % colors.length]!;

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={login}
        className="w-[26px] h-[26px] rounded-full flex-none object-cover"
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <span
      className="avatar w-[26px] h-[26px] text-[10px]"
      style={{ background: color, color: "#fff" }}
    >
      {initials}
    </span>
  );
}

// ── MembersPage ─────────────────────────────────────────────────────────────

export function MembersPage() {
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [currentUser, setCurrentUser] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MemberEntry | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [membersData, userData] = await Promise.all([
        fetchMembers(),
        fetchMe(),
      ]);
      setMembers(membersData);
      setCurrentUser(userData);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError("You need to sign in to view this page.");
        } else {
          setError(err.message);
        }
      } else {
        setError("Failed to load members");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Derived state ──────────────────────────────────────────────────────
  const isOwner = currentUser?.role === "owner";
  const isAdminOrAbove =
    currentUser?.role === "admin" || currentUser?.role === "owner";
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const isSingleMember = members.length <= 1;

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleRoleChange = useCallback(
    async (userId: string, newRole: Role) => {
      const result = await changeMemberRole(userId, newRole);
      setMembers((prev) =>
        prev.map((m) =>
          m.userId === userId ? { ...m, role: result.role } : m,
        ),
      );
    },
    [],
  );

  const handleRemove = useCallback(async (userId: string) => {
    await removeMember(userId);
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
    setRemoveTarget(null);
  }, []);

  const formatJoinedAt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div className="page-head">
        <div className="ph-text">
          <h1>Members</h1>
          <p className="sub">
            People who can sign in to this portal. Roles are per team — a user
            can belong to multiple teams with different roles.
          </p>
        </div>
        {(isAdminOrAbove || isSingleMember) && (
          <div className="ph-actions">
            <button
              className="btn btn-primary"
              onClick={() => setInviteModalOpen(true)}
              type="button"
            >
              <Plus className="w-[15px] h-[15px]" />
              Invite member
            </button>
          </div>
        )}
      </div>

      {/* Error state */}
      {error && !loading && (
        <Banner variant="error" className="mb-4">
          {error}
        </Banner>
      )}

      {/* Loading state */}
      {loading && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th style={{ width: 200 }}>Role</th>
                <th style={{ width: 140 }}>Joined</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3].map((i) => (
                <tr key={i}>
                  <td>
                    <div className="flex gap-[10px] items-center">
                      <Skeleton className="w-[26px] h-[26px] rounded-full" />
                      <div>
                        <Skeleton className="h-[13px] w-[100px] mt-0.5" />
                        <Skeleton className="h-[10px] w-[140px] mt-[7px]" />
                      </div>
                    </div>
                  </td>
                  <td>
                    <Skeleton className="h-[15px] w-[60px]" />
                  </td>
                  <td>
                    <Skeleton className="h-[12px] w-[80px]" />
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state: single member */}
      {!loading && !error && isSingleMember && (
        <div className="card">
          <EmptyState
            icon={Users}
            title="It's just you so far"
            description="Invite a teammate to share what your team knows — their agent gets the same memory as yours."
            actions={
              <button
                className="btn btn-primary"
                onClick={() => setInviteModalOpen(true)}
                type="button"
              >
                <Plus className="w-[15px] h-[15px]" />
                Invite your first teammate
              </button>
            }
          />
        </div>
      )}

      {/* Members table */}
      {!loading && !error && !isSingleMember && (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th style={{ width: 200 }}>Role</th>
                <th style={{ width: 140 }}>Joined</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.userId === currentUser?.userId;
                const isOnlyOwner =
                  m.role === "owner" && ownerCount <= 1;
                const canManage = isOwner && !isSelf;

                return (
                  <tr key={m.userId}>
                    {/* Member cell */}
                    <td>
                      <div className="flex gap-[10px] items-center">
                        <MemberAvatar
                          login={m.githubLogin}
                          avatarUrl={m.avatarUrl}
                        />
                        <div>
                          <span className="font-semibold text-[13.5px]">
                            {m.principalDisplayLogin ?? m.githubLogin}
                            {isSelf && (
                              <span className="pill ml-2 text-[10px] py-px">
                                You
                              </span>
                            )}
                          </span>
                          <br />
                          <span className="text-[12px] text-text-2">
                            {m.githubLogin !==
                            (m.principalDisplayLogin ?? m.githubLogin)
                              ? `${m.githubLogin} · `
                              : ""}
                            github.com/{m.githubLogin}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Role cell */}
                    <td>
                      {isOwner ? (
                        <RoleDropdown
                          currentRole={m.role}
                          isLastOwner={isSelf && isOnlyOwner}
                          isSelf={isSelf}
                          onChange={(role) => handleRoleChange(m.userId, role)}
                        />
                      ) : (
                        <RoleBadge role={m.role} />
                      )}
                    </td>

                    {/* Joined cell */}
                    <td className="text-[13px] text-text-2">
                      {formatJoinedAt(m.joinedAt)}
                    </td>

                    {/* Actions cell */}
                    <td>
                      {canManage && !isOnlyOwner && (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: "var(--red)" }}
                          onClick={() => setRemoveTarget(m)}
                          type="button"
                        >
                          Remove
                        </button>
                      )}
                      {/* Show disabled remove for last owner */}
                      {canManage && isOnlyOwner && m.role === "owner" && (
                        <span
                          className="text-[12px] text-text-3"
                          title="Cannot remove the last owner"
                        >
                          Last owner
                        </span>
                      )}
                      {/* Owner can see their own remove as disabled */}
                      {isSelf && isOnlyOwner && m.role === "owner" && (
                        <span
                          className="text-[12px] text-text-3"
                          title="Cannot remove yourself as the last owner"
                        >
                          Last owner
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer note */}
      {!loading && !error && !isSingleMember && (
        <p className="text-[12px] text-text-3 mt-[10px]">
          Only owners can change roles or remove members. The last remaining
          owner can&apos;t be demoted or removed.
        </p>
      )}

      {/* Invite modal */}
      <InviteModal
        teamId={currentUser?.teamId ?? null}
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        currentUserRole={currentUser?.role ?? null}
      />

      {/* Remove confirmation */}
      {removeTarget && (
        <RemoveConfirmDialog
          login={removeTarget.githubLogin}
          onConfirm={() => handleRemove(removeTarget.userId)}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
