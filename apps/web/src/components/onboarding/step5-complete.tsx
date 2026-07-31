/**
 * Step 5 — Done: first knowledge page and live stats.
 *
 * Uses the API key minted in Step 4 for Bearer auth on the v1 read
 * endpoints (requireAuth middleware).  Queries with the correct
 * `projectId` parameter and parses the real `{requestId, data, nextCursor}`
 * response shape.
 *
 * Two views:
 *   - success: shows event/job/page indicators + the latest compiled page
 *   - waiting: honest empty state with troubleshooting guidance
 *
 * Counts reflect the actual number of items returned (≤ page size of 100).
 * For a fresh deployment counts will be small and exact; for larger
 * deployments the count is a lower bound (e.g. "≥100").  The UI reports
 * what it actually observes rather than fabricating numbers.
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
  Cpu,
  AlertTriangle,
  Check,
  Key as KeyIcon,
} from "lucide-react";

const POLL_INTERVAL_MS = 5000;

export function Step5Complete({
  projectId,
  apiKey,
  /** True when the user skipped Step 4 (no API key was minted). */
  keySkipped,
  onGoToKnowledge,
}: {
  projectId: string;
  /** API key minted in Step 4 — used for Bearer auth on v1 endpoints. */
  apiKey: string;
  keySkipped: boolean;
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
        getOnboardingStats(projectId, apiKey),
        getLatestConcept(projectId, apiKey),
      ]);
      setStats(s);
      setLatestPage(p);
      setError(null);
      // If we have at least one page, stop polling
      if (p && s.hasPages) {
        setPolling(false);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch stats.",
      );
      setPolling(false);
    }
  }, [projectId, apiKey]);

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

  const hasData = stats && (stats.hasEvents || stats.hasPages);

  // ── Key skipped state: no Bearer token, can't poll read endpoints ───

  if (keySkipped) {
    return (
      <div>
        <h1>Waiting for the first events…</h1>
        <p className="wiz-sub">
          You skipped minting an API key in Step 4, so we can&apos;t check
          whether events or pages have arrived yet. You can still visit the
          Knowledge page — if events are flowing, pages will appear there.
        </p>

        <div className="card card-pad">
          <div className="stat-row">
            <div className="stat">
              <span className="num" style={{ color: "var(--text-3)" }}>—</span>
              <span className="lbl">Events received</span>
            </div>
            <div className="stat">
              <span className="num" style={{ color: "var(--text-3)" }}>—</span>
              <span className="lbl">Jobs found</span>
            </div>
            <div className="stat">
              <span className="num" style={{ color: "var(--text-3)" }}>—</span>
              <span className="lbl">Pages compiled</span>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h3>Want live stats?</h3>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <KeyIcon
                className="ic"
                style={{ color: "var(--accent)", marginTop: 2 }}
              />
              <div className="small" style={{ flex: 1 }}>
                Mint an API key in{" "}
                <strong>Settings → API keys</strong> and return here — or
                simply visit the Knowledge page to see what&apos;s been
                compiled so far.
              </div>
            </div>
          </div>
        </div>

        <div className="wiz-foot">
          <span className="spacer" />
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

  // ── Error state ────────────────────────────────────────────────────────

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

  // ── Success state ──────────────────────────────────────────────────────

  if (hasData) {
    return (
      <div>
        <h1>Your first knowledge is here</h1>
        <p className="wiz-sub">
          Events are arriving and the compiler is running. This page updates
          live.
        </p>

        {/* Stats row — shows observed counts */}
        <div className="card card-pad">
          <div className="stat-row">
            <div className="stat">
              <span className="num">{stats?.eventsCount ?? 0}</span>
              <span className="lbl">Events received</span>
            </div>
            <div className="stat">
              <span className="num">{stats?.jobsCount ?? 0}</span>
              <span className="lbl">Jobs found</span>
            </div>
            <div className="stat">
              <span
                className="num"
                style={{
                  color:
                    (stats?.pagesCount ?? 0) > 0
                      ? "var(--green)"
                      : undefined,
                }}
              >
                {stats?.pagesCount ?? 0}
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
                style={{ color: "var(--text-3)", marginTop: 4 }}
              />
            </a>
          </div>
        )}

        <div className="wiz-foot">
          <span className="spacer" />
          {latestPage && (
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

  // ── Waiting state: honest empty + troubleshooting ──────────────────────

  return (
    <div>
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
            <span className="lbl">Jobs found</span>
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
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Terminal
              className="ic"
              style={{ color: "var(--accent)", marginTop: 2 }}
            />
            <div className="small" style={{ flex: 1 }}>
              Run <code className="mono">teamem init</code> in a local repo
              — fastest way to seed events (command from the previous step).
            </div>
          </div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <svg
              className="ic"
              viewBox="0 0 24 24"
              fill="currentColor"
              style={{ color: "var(--accent)", marginTop: 2 }}
            >
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
            </svg>
            <div className="small" style={{ flex: 1 }}>
              Pushed code doesn&apos;t show up? Make sure the GitHub App is{" "}
              <strong>installed on that repository</strong> (see Step 3).
            </div>
          </div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Cpu
              className="ic"
              style={{ color: "var(--accent)", marginTop: 2 }}
            />
            <div className="small" style={{ flex: 1 }}>
              Events arrive but no pages? Compilation needs an LLM provider
              (configured via environment variables, see Step 2) — events are
              stored either way.
            </div>
          </div>
        </div>
      </div>

      <div className="wiz-foot">
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => void fetchData()}
        >
          <RefreshCw className="ic" />
          Refresh
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
