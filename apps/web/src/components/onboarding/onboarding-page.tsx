/**
 * Onboarding wizard — 5-step focused flow (no app shell).
 *
 * Steps:
 *   1. Create team & project
 *   2. Configure LLM provider (with FTS degradation warning)
 *   3. Choose repositories (GitHub App installation scope)
 *   4. Mint API key (one-time plaintext + paste commands)
 *   5. Done — live stats + first knowledge page / waiting state
 *
 * Progress is persisted in sessionStorage so the user can leave and return.
 * The wizard renders outside the main AppShell — it's a focused experience.
 */
import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import { Step1CreateTeam, type Step1Data, type ExistingTeam } from "./step1-create-team";
import { Step2LlmProvider, type Step2Data } from "./step2-llm-provider";
import { Step3Repositories, type Step3Data } from "./step3-repositories";
import { Step4MintKey, type Step4Data } from "./step4-mint-key";
import { Step5Complete } from "./step5-complete";
import { OnboardingSignIn } from "./onboarding-signin";
import { getSession, fetchProjects } from "@/lib/api";

// ── Persistent state ───────────────────────────────────────────────────────

const STORAGE_KEY = "teamem-onboarding";

interface OnboardingState {
  currentStep: number;
  step1?: Step1Data;
  step2?: Step2Data;
  step3?: Step3Data;
  step4?: Step4Data;
  completed: boolean;
}

function loadState(): OnboardingState {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as OnboardingState;
  } catch {
    // corrupted state — start fresh
  }
  return { currentStep: 1, completed: false };
}

function saveState(state: OnboardingState) {
  try {
    // R7: the API key plaintext must never be persisted — strip it
    // before serialising.  Step 5 needs the token in memory to poll,
    // but it must not survive a page reload or browser close.
    const safe: OnboardingState = {
      ...state,
      step4: state.step4
        ? { ...state.step4, token: "", mcpCommand: "" }
        : undefined,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // storage full or unavailable — non-critical
  }
}

// ── Step labels ────────────────────────────────────────────────────────────

const STEP_LABELS = ["Team", "LLM", "Repos", "Connect", "Done"];

// ── Component ──────────────────────────────────────────────────────────────

export function OnboardingPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<OnboardingState>(loadState);

  // Persist on every change
  useEffect(() => {
    saveState(state);
  }, [state]);

  const goToStep = useCallback(
    (step: number) => setState((prev) => ({ ...prev, currentStep: step })),
    [],
  );

  // Discard any persisted wizard progress and return to a clean step 1. Used
  // by the entry guard when the backend shows onboarding is not actually
  // done (no project), so stale step2–4 state can't drive an invalid request.
  const resetWizard = useCallback(
    () => setState({ currentStep: 1, completed: false }),
    [],
  );

  // ── Entry guard ────────────────────────────────────────────────────────
  // The onboarding wizard is the portal's front door (App.tsx routes "/" and
  // any signed-out internal page here). It has to handle every arrival state,
  // because "has a team" does NOT mean "already onboarded" — every first
  // GitHub login auto-bootstraps a team (see ensureTeamMembership); a project
  // is what actually marks onboarding done. Resolve it once up front:
  //   - No session                → show the GitHub sign-in step (step 0),
  //                                  NOT a redirect to /login — the wizard is
  //                                  the front door, sign-in lives inside it
  //   - Team + at least 1 project → already onboarded, /knowledge
  //   - Team + 0 projects         → resume at Step 1 as "create your first
  //                                  project", reusing the existing team
  //                                  (see ExistingTeam doc on Step1CreateTeam)
  //   - No team at all            → genuinely fresh signup, full flow
  const [entry, setEntry] = useState<
    | { status: "checking" }
    | { status: "signed-out" }
    | { status: "ready"; existingTeam: ExistingTeam | null }
  >({ status: "checking" });

  useEffect(() => {
    let cancelled = false;

    async function checkEntry() {
      try {
        const session = await getSession();
        if (cancelled) return;

        if (!session) {
          setEntry({ status: "signed-out" });
          return;
        }

        if (session.teamId) {
          const projects = await fetchProjects(session.teamId);
          if (cancelled) return;

          if (projects.length > 0) {
            navigate("/knowledge", { replace: true });
            return;
          }

          // Team but no project. Any persisted progress past step 1 is stale:
          // its saved step1.project.id points at a project that no longer
          // exists (e.g. the DB was reset since), and step 4 would mint a key
          // against that dead id → HTTP 404. Restart the wizard at step 1.
          resetWizard();
          setEntry({
            status: "ready",
            existingTeam: {
              id: session.teamId,
              name: session.teamName ?? "",
              role: session.role ?? "owner",
            },
          });
          return;
        }

        // No team yet — a genuinely fresh start; discard any stale progress.
        resetWizard();
        setEntry({ status: "ready", existingTeam: null });
      } catch {
        // A transient failure must not strand the visitor on the skeleton
        // forever. Fall back to the sign-in step — the safe default, and
        // the user can re-authenticate from there if the session is gone.
        if (!cancelled) setEntry({ status: "signed-out" });
      }
    }

    void checkEntry();
    return () => {
      cancelled = true;
    };
  }, [navigate, resetWizard]);

  // Compute server base URL from current origin (the Vite dev server proxies
  // /v1 and /auth to the backend; in production the server hosts the SPA).
  const serverBaseUrl = useMemo(() => {
    if (typeof window !== "undefined") {
      return window.location.origin;
    }
    return "http://localhost:8080";
  }, []);

  // ── Step callbacks ────────────────────────────────────────────────────

  const handleStep1Complete = useCallback(
    (data: Step1Data) => {
      setState((prev) => ({
        ...prev,
        currentStep: 2,
        step1: data,
      }));
    },
    [],
  );

  const handleStep2Complete = useCallback(
    (data: Step2Data) => {
      setState((prev) => ({
        ...prev,
        currentStep: 3,
        step2: data,
      }));
    },
    [],
  );

  const handleStep2Skip = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentStep: 3,
      step2: {
        providerKind: "claude",
        hasSemanticSearch: false,
        skipped: true,
      },
    }));
  }, []);

  const handleStep3Complete = useCallback(
    (data: Step3Data) => {
      setState((prev) => ({
        ...prev,
        currentStep: 4,
        step3: data,
      }));
    },
    [],
  );

  const handleStep3Skip = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentStep: 4,
      step3: { repoCount: 0, skipped: true },
    }));
  }, []);

  const handleStep4Complete = useCallback(
    (data: Step4Data) => {
      setState((prev) => ({
        ...prev,
        currentStep: 5,
        step4: data,
      }));
    },
    [],
  );

  const handleExit = useCallback(() => {
    navigate("/knowledge");
  }, [navigate]);

  const handleGoToKnowledge = useCallback(() => {
    setState((prev) => ({ ...prev, completed: true }));
    navigate("/knowledge");
  }, [navigate]);

  // ── Guard: if step 1 hasn't created team/project, can't proceed ──────
  const teamId = state.step1?.team?.id;
  const projectId = state.step1?.project?.id;
  const projectName = state.step1?.project?.name ?? "my-project";

  // ── Render ────────────────────────────────────────────────────────────

  const wizLogo = (
    <svg
      className="logo-mark"
      viewBox="0 0 32 32"
      fill="none"
      aria-label="teamem logo"
    >
      <rect className="fill-accent" x="1.5" y="1.5" width="29" height="29" rx="7.5" />
      <path
        d="M9 11h14M9 16h10.5M9 21h12.5"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );

  // Entry guard hasn't resolved yet (or is redirecting away) — render
  // nothing rather than flashing Step 1 at a signed-out or already-
  // onboarded visitor.
  if (entry.status === "checking") {
    return (
      <div className="wizard">
        <div className="wiz-body">
          <div className="wiz-card">
            <div className="skeleton" style={{ height: 28, width: "60%", marginBottom: 16 }} />
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 12 }} />
            <div className="skeleton" style={{ height: 32, width: "75%" }} />
          </div>
        </div>
      </div>
    );
  }

  // Signed out — the wizard's front door is the GitHub sign-in step. No step
  // indicator and no "Exit setup" (there's nowhere signed-out to exit to).
  if (entry.status === "signed-out") {
    return (
      <div className="wizard">
        <div className="wiz-top">
          {wizLogo}
          <strong>teamem</strong>
        </div>
        <div className="wiz-body">
          <div className="wiz-card">
            <OnboardingSignIn />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard">
      {/* Top bar: logo + steps + exit */}
      <div className="wiz-top">
        {wizLogo}
        <strong>teamem</strong>

        {/* Step progress indicator */}
        <div className="steps">
          {STEP_LABELS.map((label, i) => {
            const stepNum = i + 1;
            const isDone = state.currentStep > stepNum;
            const isNow = state.currentStep === stepNum;
            return (
              <span key={i} className="flex items-center gap-0">
                <span
                  className={`step${isDone ? " done" : ""}${isNow ? " now" : ""}`}
                >
                  <span className="s-dot">
                    <span className="num">{stepNum}</span>
                    {isDone && (
                      <Check
                        className="ck"
                        width={12}
                        height={12}
                      />
                    )}
                  </span>
                  <span className="s-label">{label}</span>
                </span>
                {i < STEP_LABELS.length - 1 && (
                  <span className="step-line" />
                )}
              </span>
            );
          })}
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleExit}
        >
          Exit setup
        </button>
      </div>

      {/* Body: centered card */}
      <div className="wiz-body">
        <div className="wiz-card">
          {state.currentStep === 1 && (
            <Step1CreateTeam
              existingTeam={entry.existingTeam}
              onComplete={handleStep1Complete}
            />
          )}

          {state.currentStep === 2 && teamId && (
            <Step2LlmProvider
              teamId={teamId}
              onComplete={handleStep2Complete}
              onBack={() => goToStep(1)}
              onSkip={handleStep2Skip}
            />
          )}

          {state.currentStep === 3 && teamId && (
            <Step3Repositories
              teamId={teamId}
              onComplete={handleStep3Complete}
              onBack={() => goToStep(2)}
              onSkip={handleStep3Skip}
            />
          )}

          {state.currentStep === 4 && teamId && projectId && (
            <Step4MintKey
              teamId={teamId}
              projectId={projectId}
              projectName={projectName}
              serverBaseUrl={serverBaseUrl}
              onComplete={handleStep4Complete}
              onBack={() => goToStep(3)}
            />
          )}

          {state.currentStep === 5 && projectId && (
            <Step5Complete
              projectId={projectId}
              apiKey={state.step4?.token ?? ""}
              keySkipped={!state.step4?.token}
              onGoToKnowledge={handleGoToKnowledge}
            />
          )}
        </div>
      </div>
    </div>
  );
}
