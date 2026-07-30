/**
 * Step 3 — Choose which repositories to watch.
 *
 * Shows the GitHub App installation status. Uses careful wording to avoid
 * the "reconnect" confusion: the same app handles both sign-in and ingestion.
 * This step is about setting repository scope, not a new connection.
 */
import { useState, useEffect, useCallback } from "react";
import {
  getGitHubInstallation,
  ApiRequestError,
  type GitHubInstallationStatus,
} from "./onboarding-api";
import { Check, ExternalLink, Shield, Github } from "lucide-react";

export interface Step3Data {
  repoCount: number;
  skipped: boolean;
}

export function Step3Repositories({
  teamId,
  onComplete,
  onBack,
  onSkip,
}: {
  teamId: string;
  onComplete: (data: Step3Data) => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const [status, setStatus] = useState<GitHubInstallationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getGitHubInstallation(teamId);
      setStatus(result);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        // Endpoint not yet available — show a placeholder
        setStatus(null);
        setError(null); // Not an error; the feature path is clear
      } else if (err instanceof ApiRequestError) {
        setError(err.message);
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to load repositories.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  if (loading) {
    return (
      <div>
        <h1>Choose which repositories to watch</h1>
        <p className="wiz-sub">Loading GitHub App installation status…</p>
        <div className="card card-pad">
          <div className="flex items-center gap-3">
            <div className="skeleton w-8 h-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-4 w-48" />
              <div className="skeleton h-3 w-72" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // When the endpoint isn't available yet, show the UI with a clear state
  const displayStatus = status ?? {
    appName: "teamem-portal",
    authorized: false,
    webhookSecretConfigured: false,
    repos: [],
    manageUrl: "#",
  };

  return (
    <div>
      <h1>Choose which repositories to watch</h1>
      <p className="wiz-sub">
        You already signed in with the{" "}
        <strong>{displayStatus.appName} GitHub App</strong>. This step sets
        which repositories that same app can read — no new connection, just
        repository scope.
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
              }}
            >
              <Github className="ic lg" style={{ color: "var(--text)" }} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {displayStatus.appName}{" "}
                <span className="muted" style={{ fontWeight: 400 }}>
                  · GitHub App
                </span>
              </div>
              <div className="small muted">
                Used for sign-in and ingestion — one app, created at deploy
                time
              </div>
            </div>
            {displayStatus.authorized ? (
              <span className="pill green">
                <Check className="ic" />
                Authorized
              </span>
            ) : (
              <span className="pill">Not configured</span>
            )}
          </div>
          <a
            className="btn btn-outline btn-sm"
            style={{ marginTop: 12 }}
            href={displayStatus.manageUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="ic" />
            Manage repository access on GitHub
          </a>
        </div>

        {/* Repository list */}
        {displayStatus.repos.length > 0 && (
          <>
            <hr className="divider" style={{ margin: 0 }} />
            <div className="card-body" style={{ paddingTop: 8 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>
                Watching {displayStatus.repos.length} repositor
                {displayStatus.repos.length !== 1 ? "ies" : "y"}
              </div>
              {displayStatus.repos.map((repo, i) => (
                <div key={i} className="repo-row">
                  <Check className="ic" style={{ color: "var(--green)" }} />
                  <code>{repo.fullName}</code>
                  <span className="muted small">
                    · {repo.events.join(", ")}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {!status && (
          <>
            <hr className="divider" style={{ margin: 0 }} />
            <div className="card-body" style={{ paddingTop: 8 }}>
              <div className="small muted">
                Repository list will appear here once the GitHub App is
                configured. Visit the installation page on GitHub to select
                repositories.
              </div>
            </div>
          </>
        )}

        {/* Webhook secret status */}
        {status && (
          <>
            <hr className="divider" style={{ margin: 0 }} />
            <div className="card-body" style={{ paddingTop: 12 }}>
              <div className="row small">
                <Shield
                  className="ic"
                  style={{ color: "var(--green)" }}
                />
                <span className="muted-2">
                  Webhook secret{" "}
                  <strong>
                    {displayStatus.webhookSecretConfigured
                      ? "configured"
                      : "not configured"}
                  </strong>
                  {displayStatus.webhookSecretConfigured
                    ? " — auto-generated, deliveries are signature-verified."
                    : " — configure it in your deployment environment."}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="banner error" style={{ marginTop: 14 }} role="alert">
          <Check className="ic" />
          <div>{error}</div>
        </div>
      )}

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
            onComplete({
              repoCount: displayStatus.repos.length,
              skipped: false,
            })
          }
        >
          Continue
        </button>
      </div>
    </div>
  );
}
