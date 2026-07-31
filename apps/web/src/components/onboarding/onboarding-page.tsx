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
import { Step1CreateTeam, type Step1Data } from "./step1-create-team";
import { Step2LlmProvider, type Step2Data } from "./step2-llm-provider";
import { Step3Repositories, type Step3Data } from "./step3-repositories";
import { Step4MintKey, type Step4Data } from "./step4-mint-key";
import { Step5Complete } from "./step5-complete";

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
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

  return (
    <div className="wizard">
      {/* Top bar: logo + steps + exit */}
      <div className="wiz-top">
        <svg
          className="logo-mark"
          viewBox="0 0 32 32"
          fill="none"
          aria-label="teamem logo"
        >
          <rect
            className="fill-accent"
            x="1.5"
            y="1.5"
            width="29"
            height="29"
            rx="7.5"
          />
          <path
            d="M9 11h14M9 16h10.5M9 21h12.5"
            stroke="#fff"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
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
              onGoToKnowledge={handleGoToKnowledge}
            />
          )}
        </div>
      </div>
    </div>
  );
}
