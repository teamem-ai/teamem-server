import { useEffect, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { getSession, lookupInvite, acceptInvite, type SessionUser, type InviteLookup } from "@/lib/api";
import { Banner } from "@/components/ui/banner";
import { RoleBadge } from "@/components/ui/role-badge";

// ── SVG icons ──────────────────────────────────────────────────────────────

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width="48" height="48" aria-label="teamem logo">
      <rect fill="var(--accent)" x="1.5" y="1.5" width="29" height="29" rx="7.5" />
      <path d="M9 11h14M9 16h10.5M9 21h12.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function TeamIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

// ── Role description one-liners (per GLOSSARY §3.1) ────────────────────────

const roleDescriptions: Record<string, string> = {
  owner: "Full control, including destructive actions and role management",
  admin: "Manage keys, connectors, LLM settings and audit",
  member: "Search, read payloads, preview agent context",
  viewer: "Browse knowledge and job activity, read-only",
};

// ── Invite summary card ────────────────────────────────────────────────────

function InviteSummary({
  teamName,
  targetRole,
  invitedByLogin,
  invitedByRole,
  joiningAsLogin,
}: {
  teamName: string;
  targetRole: string;
  invitedByLogin: string | null;
  invitedByRole?: string | null;
  joiningAsLogin?: string;
}) {
  const inviterInitials = (invitedByLogin ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="invite-summary">
      {/* Team row */}
      <div className="is-row">
        <span className="k">Team</span>
        <TeamIcon className="ic" />
        <strong>{teamName}</strong>
      </div>

      {/* Role row */}
      <div className="is-row">
        <span className="k">Your role</span>
        <RoleBadge role={targetRole as "owner" | "admin" | "member" | "viewer"} />
        <span className="small muted">
          {roleDescriptions[targetRole] ?? targetRole}
        </span>
      </div>

      {/* Invited by / Joining as row */}
      {joiningAsLogin ? (
        <div className="is-row">
          <span className="k">Joining as</span>
          <span
            className="avatar"
            style={{ background: "var(--emerald)" }}
            aria-hidden="true"
          >
            {joiningAsLogin.slice(0, 2).toUpperCase()}
          </span>
          <span>
            <strong>{joiningAsLogin}</strong> · signed in
          </span>
        </div>
      ) : (
        <div className="is-row">
          <span className="k">Invited by</span>
          <span
            className="avatar"
            style={{ background: "var(--violet)" }}
            aria-hidden="true"
          >
            {inviterInitials}
          </span>
          <span>
            {invitedByLogin ?? "unknown"}
            {invitedByRole && (
              <>
                {" "}·{" "}
                <span className="small muted">{invitedByRole}</span>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Page states ────────────────────────────────────────────────────────────

type InviteState =
  | "loading"
  | "guest"       // Not logged in — show "Sign in with GitHub to join"
  | "signedin"    // Logged in — show "Join team"
  | "expired"     // Invite is expired or already used
  | "notfound";   // Token not recognized

// ── Exported page component ────────────────────────────────────────────────

export function InvitePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<InviteState>("loading");
  const [session, setSession] = useState<SessionUser | null>(null);
  const [inviteData, setInviteData] = useState<InviteLookup | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const token = searchParams.get("token") ?? "";

  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!token) {
        setState("notfound");
        return;
      }

      const [sess, invite] = await Promise.allSettled([
        getSession(),
        lookupInvite(token),
      ]);

      if (cancelled) return;

      const sessionData = sess.status === "fulfilled" ? sess.value : null;
      setSession(sessionData);

      const inviteData = invite.status === "fulfilled" ? invite.value : null;
      setInviteData(inviteData);

      if (!inviteData || inviteData.status === "not_found") {
        setState("notfound");
        return;
      }

      if (inviteData.status === "expired" || inviteData.status === "used") {
        setState("expired");
        return;
      }

      // valid invite
      if (sessionData) {
        setState("signedin");
      } else {
        setState("guest");
      }
    }

    void init();
    return () => { cancelled = true; };
  }, [token]);

  async function handleAccept() {
    if (!inviteData || !token) return;
    setJoining(true);
    setAcceptError(null);
    try {
      await acceptInvite(inviteData.invite.teamId, token);
      // Redirect to knowledge after successful join
      navigate("/knowledge", { replace: true });
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : "Failed to accept invite");
    } finally {
      setJoining(false);
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────
  if (state === "loading") {
    return (
      <main className="auth" aria-busy="true">
        <div className="auth-card" style={{ maxWidth: 420 }}>
          <LogoMark />
          <h1>Join team</h1>
          <p className="tagline">&nbsp;</p>
        </div>
      </main>
    );
  }

  // ── Token not found ──────────────────────────────────────────────────
  if (state === "notfound") {
    return (
      <main className="auth">
        <div className="auth-card">
          <LogoMark />
          <div className="empty-state" style={{ padding: "24px 0 0" }}>
            <div className="e-icon">
              <ClockIcon />
            </div>
            <h3 style={{ fontSize: 20 }}>
              This invite link is no longer valid
            </h3>
            <p style={{ marginTop: 8 }}>
              It may have expired (invites last 7 days) or was already used.
              <br />
              Ask your admin to send you a fresh invite link.
            </p>
            <div className="e-actions">
              <Link to="/login" className="btn btn-outline">
                Go to sign in
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ── Expired / used ───────────────────────────────────────────────────
  if (state === "expired") {
    return (
      <main className="auth">
        <div data-view="expired">
          <div className="auth-card">
            <LogoMark />
            <div className="empty-state" style={{ padding: "24px 0 0" }}>
              <div className="e-icon">
                <ClockIcon />
              </div>
              <h3 style={{ fontSize: 20 }}>
                This invite link is no longer valid
              </h3>
              <p style={{ marginTop: 8 }}>
                It may have expired (invites last 7 days) or was already used.
                <br />
                Ask your admin to send you a fresh invite link.
              </p>
              <div className="e-actions">
                <Link to="/login" className="btn btn-outline">
                  Go to sign in
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const invite = inviteData?.invite;
  const teamName = invite?.teamName ?? "unknown team";
  const targetRole = invite?.targetRole ?? "member";
  const invitedByLogin = invite?.invitedByLogin ?? null;
  const invitedByRole = invite?.invitedByRole ?? null;

  // ── Guest (not logged in) ────────────────────────────────────────────
  if (state === "guest") {
    return (
      <main className="auth">
        <div data-view="default">
          <div className="auth-card" style={{ maxWidth: 420 }}>
            <LogoMark />
            <h1>Join {teamName}</h1>
            <p className="tagline">
              <strong>{invitedByLogin ?? "Someone"}</strong> invited you to
              join their team knowledge base on this teamem portal.
            </p>

            <InviteSummary
              teamName={teamName}
              targetRole={targetRole}
              invitedByLogin={invitedByLogin}
              invitedByRole={invitedByRole}
            />

            <div className="auth-box">
              <a
                href="/auth/github"
                className="btn btn-primary btn-lg btn-block"
                onClick={() => {
                  // Persist the invite token so the post-OAuth landing
                  // page can redirect back here after sign-in completes.
                  try {
                    sessionStorage.setItem("teamem_invite_token", token);
                  } catch { /* storage unavailable — best-effort */ }
                }}
              >
                <GitHubIcon className="ic lg" />
                Sign in with GitHub to join
              </a>
            </div>
            <p className="auth-foot">
              Invite link expires in 7 days · single use.
              <br />
              Your GitHub identity is only used to sign you in.
            </p>
          </div>
        </div>
      </main>
    );
  }

  // ── Signed in ────────────────────────────────────────────────────────
  if (state === "signedin") {
    const joiningAs = session?.githubLogin ?? "unknown";

    return (
      <main className="auth">
        <div data-view="signedin">
          <div className="auth-card" style={{ maxWidth: 420 }}>
            <LogoMark />
            <h1>Join {teamName}</h1>
            <p className="tagline">
              <strong>{invitedByLogin ?? "Someone"}</strong> invited you to
              join their team knowledge base on this teamem portal.
            </p>

            <InviteSummary
              teamName={teamName}
              targetRole={targetRole}
              invitedByLogin={invitedByLogin}
              invitedByRole={invitedByRole}
              joiningAsLogin={joiningAs}
            />

            <div className="auth-box stack">
              {acceptError && (
                <Banner variant="error" role="alert">
                  {acceptError}
                </Banner>
              )}
              <button
                className="btn btn-primary btn-lg btn-block"
                onClick={handleAccept}
                disabled={joining}
              >
                {joining ? "Joining…" : "Join team"}
              </button>
              <a
                href="/auth/logout"
                className="btn btn-ghost btn-block"
                onClick={(e) => {
                  e.preventDefault();
                  void fetch("/auth/logout", { method: "POST" }).finally(() => {
                    window.location.href = `/join?token=${encodeURIComponent(token)}`;
                  });
                }}
              >
                Not you? Switch GitHub account
              </a>
            </div>
            <p className="auth-foot">
              Invite link expires in 7 days · single use.
            </p>
          </div>
        </div>
      </main>
    );
  }

  // Fallback (should not reach)
  return null;
}
