/**
 * Step 5 — Done: first knowledge page and live stats.
 *
 * Two views:
 *   - success: shows live event/job/page counts + the latest compiled page
 *   - waiting: honest empty state with troubleshooting guidance
 *
 * Counts update on a polling interval. The waiting state maps three real
 * failure modes to concrete checks: init not run, App not installed on the
 * repo, events arriving but no LLM provider configured.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  getOnboardingStats,
  getLatestConcept,
  type OnboardingStats,
  type LatestConceptPage,
} from "./onboarding-api";
import { TypeBadge, ConfidenceMeter } from "@/components/ui";
import type { ConceptType } from "@/components/ui/type-badge";
import type { ConfidenceLevel } from "@/components/ui/confidence-meter";
import {
  RefreshCw,
  ChevronRight,
  Terminal,
  Github,
  Cpu,
  AlertTriangle,
  Check,
} from "lucide-react";

const POLL_INTERVAL_MS = 5000;

export function Step5Complete({
  projectId,
  onGoToKnowledge,
}: {
  projectId: string;
  onGoToKnowledge: () => void;
}) {
  const [stats, setStats] = useState<OnboardingStats | null>(null);
  const [latestPage, setLatestPage] = useState<LatestConceptPage | null>(null);
  const [polling, setPolling] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        getOnboardingStats(projectId),
        getLatestConcept(projectId),
      ]);
      setStats(s);
      setLatestPage(p);
      setError(null);
      // If we have at least one page, stop polling
      if (p && s.pagesCompiled > 0) {
        setPolling(false);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch stats.",
      );
      setPolling(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchData();

    if (polling) {
      intervalRef.current = setInterval(fetchData, POLL_INTERVAL_MS);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchData, polling]);

  const hasData = stats && (stats.eventsReceived > 0 || stats.pagesCompiled > 0);
  const isWaiting = !hasData && !error;

  if (error) {
    return (
      <div>
        <h1>Almost there</h1>
        <p className="wiz-sub">
          We couldn&apos;t check your knowledge base status. This doesn&apos;t
          mean nothing is working — the portal might just need a moment.
        </p>
        <div className="banner warn" style={{ marginTop: 14 }} role="status">
          <AlertTriangle className="ic" />
          <div>{error}</div>
        </div>
        <div className="wiz-foot">
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => {
              setPolling(true);
              setError(null);
              void fetchData();
            }}
          >
            <RefreshCw className="ic" />
            Retry
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onGoToKnowledge}
          >
            Go to Knowledge
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {hasData ? (
        <>
          {/* ── Success state: first knowledge is here ── */}
          <h1>Your first knowledge is here</h1>
          <p className="wiz-sub">
            Events are arriving and the compiler is running. This page updates
            live.
          </p>

          {/* Stats row */}
          <div className="card card-pad">
            <div className="stat-row">
              <div className="stat">
                <span className="num">{stats?.eventsReceived ?? 0}</span>
                <span className="lbl">Events received</span>
              </div>
              <div className="stat">
                <span className="num">{stats?.jobsRunning ?? 0}</span>
                <span className="lbl">Jobs running</span>
              </div>
              <div className="stat">
                <span
                  className="num"
                  style={{
                    color:
                      (stats?.pagesCompiled ?? 0) > 0
                        ? "var(--green)"
                        : undefined,
                  }}
                >
                  {stats?.pagesCompiled ?? 0}
                </span>
                <span className="lbl">Pages compiled</span>
              </div>
            </div>
          </div>

          {/* Latest page card */}
          {latestPage && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-head">
                <h3>Latest page</h3>
                <span className="ch-actions">
                  <span className="pill green">
                    <Check className="ic" />
                    Compiled just now
                  </span>
                </span>
              </div>
              <a
                className="krow"
                href={`/concepts/${encodeURIComponent(latestPage.uuid)}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div className="k-main">
                  <div className="k-title">
                    <TypeBadge type={latestPage.type as ConceptType} />
                    {latestPage.title}
                  </div>
                  <div className="k-meta">
                    <span className="path">{latestPage.path}</span>
                    <span>{latestPage.evidenceCount} evidence</span>
                    <ConfidenceMeter
                      level={latestPage.confidence as ConfidenceLevel}
                    />
                  </div>
                </div>
                <ChevronRight
                  className="ic"
                  style={{
                    color: "var(--text-3)",
                    marginTop: 4,
                  }}
                />
              </a>
            </div>
          )}
        </>
      ) : isWaiting ? (
        <>
          {/* ── Waiting state: honest empty state with troubleshooting ── */}
          <h1>Waiting for the first events…</h1>
          <p className="wiz-sub">
            The portal is listening. Pages appear here as soon as events are
            compiled.
          </p>

          {/* Stats row — all zeros */}
          <div className="card card-pad">
            <div className="stat-row">
              <div className="stat">
                <span className="num">0</span>
                <span className="lbl">Events received</span>
              </div>
              <div className="stat">
                <span className="num">0</span>
                <span className="lbl">Jobs running</span>
              </div>
              <div className="stat">
                <span className="num">0</span>
                <span className="lbl">Pages compiled</span>
              </div>
            </div>
          </div>

          {/* Troubleshooting guidance */}
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h3>No events yet? Check these</h3>
            </div>
            <div className="card-body stack" style={{ gap: 14 }}>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <Terminal
                  className="ic"
                  style={{ color: "var(--accent)", marginTop: 2 }}
                />
                <div className="small" style={{ flex: 1 }}>
                  Run <code className="mono">teamem init</code> in a local repo
                  — fastest way to seed events (command from the previous
                  step).
                </div>
              </div>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <Github
                  className="ic"
                  style={{ color: "var(--accent)", marginTop: 2 }}
                />
                <div className="small" style={{ flex: 1 }}>
                  Pushed code doesn&apos;t show up? Make sure the GitHub App is{" "}
                  <strong>installed on that repository</strong> (Step 3).
                </div>
              </div>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <Cpu
                  className="ic"
                  style={{ color: "var(--accent)", marginTop: 2 }}
                />
                <div className="small" style={{ flex: 1 }}>
                  Events arrive but no pages? Compilation needs an LLM provider
                  (Step 2) — events are stored either way.
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <div className="wiz-foot">
        <span className="spacer" />
        {isWaiting && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => void fetchData()}
          >
            <RefreshCw className="ic" />
            Refresh
          </button>
        )}
        {hasData && latestPage && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => {
              window.location.href = `/concepts/${encodeURIComponent(latestPage.uuid)}`;
            }}
          >
            View your first team knowledge
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={onGoToKnowledge}
        >
          Go to Knowledge
        </button>
      </div>
    </div>
  );
}


