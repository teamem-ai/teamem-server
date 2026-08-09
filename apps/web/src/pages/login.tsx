import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  getSession,
  getGitHubStatus,
  type SessionUser,
} from "@/lib/api";
import { Banner } from "@/components/ui/banner";

// ── SVG icon paths (Lucide-style 24px viewBox, stroke 2) ──────────────────

/** GitHub octocat mark (official path). */
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

/** Logo mark: rounded square with three staggered horizontal lines. */
function LogoMark() {
  return (
    <svg
      className="logo-mark"
      viewBox="0 0 32 32"
      width="48"
      height="48"
      aria-label="teamem logo"
    >
      <rect fill="var(--accent)" x="1.5" y="1.5" width="29" height="29" rx="7.5" />
      <path
        d="M9 11h14M9 16h10.5M9 21h12.5"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function LightningIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

// ── Feature list (static copy from the design) ────────────────────────────

const features = [
  {
    Icon: LightningIcon,
    text: (
      <>
        <strong>Compiled, not written.</strong> Knowledge is distilled from
        commits, PR discussions and issues — nobody has to write docs.
      </>
    ),
  },
  {
    Icon: LinkIcon,
    text: (
      <>
        <strong>Every claim has evidence.</strong> One click back to the exact
        commit or PR discussion it came from.
      </>
    ),
  },
  {
    Icon: ShieldIcon,
    text: (
      <>
        <strong>Self-hosted.</strong> Your portal, your machine — team data
        never leaves your infrastructure.
      </>
    ),
  },
];

// ── Page states ────────────────────────────────────────────────────────────

type LoginState =
  | "loading"
  | "default"
  | "error"
  | "noconfig"
  | "noteam";

// The banner already prefixes every message with a static "Sign-in didn't
// complete." title (see the b-title span below) — these strings are just
// the explanation/next-step clause, not a restatement of the title.
const errorMessages: Record<string, string> = {
  github_denied: "GitHub authorization was cancelled or failed — please try again.",
  invalid_request: "The sign-in request was malformed. Please try again.",
  invalid_state: "Your sign-in session expired. Please try again.",
  auth_failed: "Please try again.",
};

function errorLabel(code: string): string {
  return errorMessages[code] ?? "Please try again.";
}

// ── Exported page component ────────────────────────────────────────────────

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<LoginState>("loading");
  const [session, setSession] = useState<SessionUser | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Read query params
      const err = searchParams.get("error");
      const noTeam = searchParams.get("noteam");
      if (err) {
        setErrorCode(err);
      }

      let ghConfigured = true;
      let sess: SessionUser | null = null;

      // Fire both requests in parallel
      const [ghStatus, sessionData] = await Promise.allSettled([
        getGitHubStatus(),
        getSession(),
      ]);

      if (cancelled) return;

      if (ghStatus.status === "fulfilled") {
        ghConfigured = ghStatus.value.configured;
      }
      if (sessionData.status === "fulfilled") {
        sess = sessionData.value;
      }

      setSession(sess);

      // Determine state
      if (sess && sess.teamId) {
        // Already logged in and has a team — redirect to app
        navigate("/knowledge", { replace: true });
        return;
      }

      if ((sess && !sess.teamId) || noTeam === "1") {
        setState("noteam");
        return;
      }

      if (!ghConfigured) {
        setState("noconfig");
        return;
      }

      if (err) {
        setState("error");
        return;
      }

      setState("default");
    }

    void init();
    return () => { cancelled = true; };
  }, [searchParams, navigate]);

  // ── Loading state ───────────────────────────────────────────────────
  if (state === "loading") {
    return (
      <main className="auth" aria-busy="true">
        <div className="auth-card">
          <LogoMark />
          <h1>teamem</h1>
          <p className="tagline" aria-hidden="true">&nbsp;</p>
        </div>
      </main>
    );
  }

  // ── App not configured ──────────────────────────────────────────────
  if (state === "noconfig") {
    return (
      <main className="auth">
        <div data-view="noconfig">
          <div className="auth-card">
            <LogoMark />
            <h1>teamem</h1>
            <p className="tagline">
              Team knowledge, compiled from real development work.
            </p>

            <div className="auth-box stack" style={{ textAlign: "left" }}>
              <Banner variant="warn" role="status">
                <span className="b-title">Sign-in isn&apos;t configured yet.</span>
                <br />
                The operator needs to create a{" "}
                <strong>GitHub App</strong> and add its credentials to{" "}
                <code className="mono">.env</code> before starting the portal.
                See <strong>README → Setup</strong>.
              </Banner>
              <button className="btn btn-primary btn-lg btn-block" disabled>
                <GitHubIcon className="ic lg" />
                Sign in with GitHub
              </button>
            </div>

            <p className="auth-foot">
              The same GitHub App is used for sign-in and for ingesting
              repository events — it is created once, before{" "}
              <code className="mono">docker compose up</code>.
            </p>
          </div>
        </div>
      </main>
    );
  }

  // ── No team (authenticated but not in any team) ─────────────────────
  if (state === "noteam") {
    return (
      <main className="auth">
        <div data-view="noteam">
          <div className="auth-card">
            <LogoMark />
            <h1>You&apos;re not in a team yet</h1>
            <p className="tagline">
              You signed in as <strong>{session?.githubLogin ?? "unknown"}</strong>
              , but this account isn&apos;t a member of any team on this portal.
            </p>

            <div className="auth-box stack" style={{ textAlign: "left" }}>
              <Banner variant="info">
                Ask your admin for an <strong>invite link</strong>, then open
                it while signed in. Invite links look like{" "}
                <code className="mono">/join?token=inv_…</code> and expire
                after 7 days.
              </Banner>
              <button
                className="btn btn-outline btn-block"
                onClick={() => {
                  // Sign out by calling the logout endpoint, then reload
                  void fetch("/auth/logout", { method: "POST" }).finally(() => {
                    window.location.href = "/login";
                  });
                }}
              >
                Sign out and switch GitHub account
              </button>
            </div>

            <p className="auth-foot">
              Deploying your own portal? See the README to get started.
            </p>
          </div>
        </div>
      </main>
    );
  }

  // ── Default / OAuth error ───────────────────────────────────────────
  return (
    <main className="auth">
      <div data-view={errorCode ? "error" : "default"}>
        <div className="auth-card">
          <LogoMark />
          <h1>teamem</h1>
          <p className="tagline">
            Team knowledge, compiled from real development work.
            <br />
            Every page links back to the commits, PRs and discussions it came from.
          </p>

          <div className="auth-box stack">
            {errorCode && (
              <Banner variant="error" role="alert">
                <span className="b-title">Sign-in didn&apos;t complete.</span>{" "}
                {errorLabel(errorCode)}
              </Banner>
            )}
            <a
              href="/auth/github"
              className="btn btn-primary btn-lg btn-block"
            >
              <GitHubIcon className="ic lg" />
              Sign in with GitHub
            </a>
          </div>

          <div className="auth-feats">
            {features.map(({ Icon, text }, i) => (
              <div className="af" key={i}>
                <Icon className="ic" />
                <span>{text}</span>
              </div>
            ))}
          </div>

          <p className="auth-foot">
            Access is by team invitation.
            <br />
            teamem is open source — you are signing in to your own portal.
          </p>
        </div>
      </div>
    </main>
  );
}
