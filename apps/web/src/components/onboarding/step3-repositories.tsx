/**
 * Step 3 — Choose which repositories to watch.
 *
 * The GitHub App is configured at deploy time (GITHUB_APP_CLIENT_ID, etc.).
 * Repository access is managed on github.com, not through the teamem API.
 * There is no GET /v1/teams/:teamId/github-installation endpoint.
 *
 * This step explains the architecture: the same GitHub App handles both
 * sign-in (OAuth) and ingestion (webhooks).  The user is directed to
 * github.com to manage repository access.
 */
import { ExternalLink, Shield, Check } from "lucide-react";

export interface Step3Data {
  repoCount: number;
  skipped: boolean;
}

export function Step3Repositories({
  onComplete,
  onBack,
  onSkip,
}: {
  teamId: string;
  onComplete: (data: Step3Data) => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <div>
      <h1>Choose which repositories to watch</h1>
      <p className="wiz-sub">
        You already signed in with the{" "}
        <strong>teamem-portal GitHub App</strong>. This step sets which
        repositories that same app can read — no new connection, just
        repository scope. Repository access is managed on GitHub, not
        through the teamem portal.
      </p>

      <div className="card">
        <div className="card-body" style={{ paddingBottom: 12 }}>
          <div className="row">
            <span
              className="avatar"
              style={{
                width: 34,
                height: 34,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 99,
              }}
            >
              <svg
                className="ic lg"
                viewBox="0 0 24 24"
                fill="currentColor"
                style={{ color: "var(--text)" }}
              >
                <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
              </svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                teamem-portal{" "}
                <span className="muted" style={{ fontWeight: 400 }}>
                  · GitHub App
                </span>
              </div>
              <div className="small muted">
                Used for sign-in and ingestion — one app, created at deploy
                time
              </div>
            </div>
            <span className="pill green">
              <Check className="ic" />
              Configured
            </span>
          </div>
          <a
            className="btn btn-outline btn-sm"
            style={{ marginTop: 12 }}
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="ic" />
            Manage repository access on GitHub
          </a>
        </div>

        <hr className="divider" style={{ margin: 0 }} />
        <div className="card-body" style={{ paddingTop: 8 }}>
          <div className="small muted">
            Repository access is configured on GitHub. Install the GitHub App
            on the repositories you want teamem to watch. Events flow in
            automatically via webhooks.
          </div>
        </div>

        <hr className="divider" style={{ margin: 0 }} />
        <div className="card-body" style={{ paddingTop: 12 }}>
          <div className="row small">
            <Shield className="ic" style={{ color: "var(--green)" }} />
            <span className="muted-2">
              Webhook secret{" "}
              <strong>configured</strong> — set via{" "}
              <code className="mono">GITHUB_WEBHOOK_SECRET</code> at deploy
              time. Deliveries are signature-verified.
            </span>
          </div>
        </div>
      </div>

      <div className="wiz-foot">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-outline"
          onClick={onSkip}
        >
          Skip — I&apos;ll use CLI / MCP instead
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() =>
            onComplete({ repoCount: 0, skipped: false })
          }
        >
          Continue
        </button>
      </div>
    </div>
  );
}
