/**
 * Onboarding step 0 — sign in with GitHub.
 *
 * On a fresh self-hosted portal the onboarding wizard is the entry point, but
 * creating a team needs an authenticated identity (the server must know who to
 * make owner), and GitHub OAuth is the only sign-in. So the wizard's first
 * screen is this sign-in gate: after OAuth the server auto-bootstraps the
 * team, and the visitor returns into the numbered setup steps.
 *
 * This is intentionally not one of the five numbered steps — it's the gate in
 * front of them, shown only while signed out.
 */
import { Sparkles, Link2, ShieldCheck } from "lucide-react";

/** GitHub octocat mark (official path). */
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

const FEATURES = [
  {
    Icon: Sparkles,
    text: (
      <>
        <strong>Compiled, not written.</strong> Knowledge is distilled from
        commits, PR discussions and issues — nobody writes docs.
      </>
    ),
  },
  {
    Icon: Link2,
    text: (
      <>
        <strong>Every claim has evidence.</strong> One click back to the exact
        commit or PR discussion it came from.
      </>
    ),
  },
  {
    Icon: ShieldCheck,
    text: (
      <>
        <strong>Self-hosted.</strong> Your portal, your machine — team data
        never leaves your infrastructure.
      </>
    ),
  },
];

export function OnboardingSignIn() {
  return (
    <div>
      <h1>Set up your teamem portal</h1>
      <p className="wiz-sub">
        You&apos;re the first user on this portal. Sign in with GitHub to
        create your team — you&apos;ll become the <strong>owner</strong>, and
        we&apos;ll walk you through the rest.
      </p>

      <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <a href="/auth/github" className="btn btn-primary btn-lg btn-block">
          <GitHubIcon className="ic lg" />
          Sign in with GitHub
        </a>

        <div className="auth-feats" style={{ margin: 0 }}>
          {FEATURES.map(({ Icon, text }, i) => (
            <div className="af" key={i}>
              <Icon className="ic" />
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="hint" style={{ marginTop: 14 }}>
        Sign-in uses the GitHub App the operator configured at deploy time. If
        this button doesn&apos;t work, GitHub OAuth isn&apos;t set up yet — see
        the deployment README.
      </p>
    </div>
  );
}
