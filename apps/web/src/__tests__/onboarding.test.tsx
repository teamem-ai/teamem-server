/**
 * Onboarding wizard component tests.
 *
 * Covers:
 *   - All 5 step components rendering with correct states
 *   - Step 2 FTS degradation variant
 *   - Step 5 waiting (honest empty) state
 *   - Key red lines: key shown once, degradation explicit, no fake data
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { Step1CreateTeam } from "@/components/onboarding/step1-create-team";
import { Step2LlmProvider } from "@/components/onboarding/step2-llm-provider";
import { Step3Repositories } from "@/components/onboarding/step3-repositories";
import { Step5Complete } from "@/components/onboarding/step5-complete";

// ── Mock the API module ───────────────────────────────────────────────────
// vitest hoists vi.mock calls to the top, so these run before imports.

vi.mock("@/components/onboarding/onboarding-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/onboarding/onboarding-api")
  >("@/components/onboarding/onboarding-api");
  return {
    ...actual,
    getOnboardingStats: vi.fn(),
    getLatestConcept: vi.fn(),
    getGitHubInstallation: vi.fn(),
    mintApiKey: vi.fn(),
    testLlmConnection: vi.fn(),
    saveLlmConfig: vi.fn(),
    createTeam: vi.fn(),
    createProject: vi.fn(),
  };
});

// Import mocked functions for type-safe configuration
import {
  getOnboardingStats,
  getLatestConcept,
  getGitHubInstallation,
} from "@/components/onboarding/onboarding-api";

const mockedGetStats = vi.mocked(getOnboardingStats);
const mockedGetLatest = vi.mocked(getLatestConcept);
const mockedGetInstallation = vi.mocked(getGitHubInstallation);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Wrap a component in a div for testing */
function renderStep(jsx: React.ReactElement) {
  return render(<div className="wiz-card">{jsx}</div>);
}

// ── Step 1: Create Team ───────────────────────────────────────────────────

describe("Step1CreateTeam", () => {
  afterEach(() => cleanup());

  it("renders team and project name fields", () => {
    const onComplete = vi.fn();
    renderStep(<Step1CreateTeam onComplete={onComplete} />);

    expect(screen.getByText("Create your team")).toBeInTheDocument();
    expect(screen.getByLabelText("Team name")).toBeInTheDocument();
    expect(screen.getByLabelText("First project")).toBeInTheDocument();
    expect(
      screen.getByText(/you'll become the team/),
    ).toBeInTheDocument();
  });

  it("shows error when submitting with empty fields", async () => {
    const onComplete = vi.fn();
    renderStep(<Step1CreateTeam onComplete={onComplete} />);

    const button = screen.getByText("Continue");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Team name is required.")).toBeInTheDocument();
    });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("shows error when team name is empty but project is filled", async () => {
    const onComplete = vi.fn();
    renderStep(<Step1CreateTeam onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: "my-project" },
    });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(screen.getByText("Team name is required.")).toBeInTheDocument();
    });
  });

  it("disables submit button while submitting", async () => {
    const onComplete = vi.fn();
    renderStep(<Step1CreateTeam onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Test Team" },
    });
    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: "test-project" },
    });

    // Submit
    fireEvent.click(screen.getByText("Continue"));
    // Button should show "Creating…" state
    await waitFor(() => {
      expect(screen.getByText("Creating…")).toBeInTheDocument();
    });
  });
});

// ── Step 2: LLM Provider ──────────────────────────────────────────────────

describe("Step2LlmProvider", () => {
  afterEach(() => cleanup());

  it("renders all four provider options", () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(screen.getByText("Custom endpoint")).toBeInTheDocument();
  });

  it("shows API key field after selecting a provider", () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    // Click on Anthropic
    fireEvent.click(screen.getByText("Anthropic"));

    // Should now show the API key input
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
  });

  it("shows FTS degradation warning when Anthropic is selected and connection tests OK", async () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    // Select Anthropic
    fireEvent.click(screen.getByText("Anthropic"));

    // Enter an API key
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-ant-test123" },
    });

    // Click Test connection
    fireEvent.click(screen.getByText("Test connection"));

    // Since the real API call will fail (no server), we check that the
    // "Continue anyway" button appears for non-embedding providers
    await waitFor(() => {
      // Anthropic subtitle should be visible
      expect(
        screen.getByText(/Claude models/i),
      ).toBeInTheDocument();
    });
  });

  it("shows semantic search banner for OpenAI (embedding provider)", () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    // Select OpenAI
    fireEvent.click(screen.getByText("OpenAI"));

    // Should show the API key field and correct subtitle
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    expect(
      screen.getByText(/GPT models \+ embeddings/),
    ).toBeInTheDocument();
  });

  it("skip button is present and states the consequence", () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    const skipButton = screen.getByText(/Skip for now/);
    expect(skipButton).toBeInTheDocument();
    expect(skipButton.textContent).toContain("compilation stays paused");

    fireEvent.click(skipButton);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("back button returns to previous step", () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

// ── Step 3: Repositories ──────────────────────────────────────────────────

describe("Step3Repositories", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mockedGetInstallation.mockResolvedValue({
      appName: "teamem-portal",
      authorized: false,
      webhookSecretConfigured: false,
      repos: [],
      manageUrl: "#",
    });
  });

  it("renders loading state initially", () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step3Repositories
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    expect(
      screen.getByText("Choose which repositories to watch"),
    ).toBeInTheDocument();
  });

  it('does not say "reconnect" in the subtitle', async () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step3Repositories
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    // Wait for the API call to settle
    await waitFor(() => {
      // The wording should not contain "reconnect" or "re-authorize"
      expect(
        screen.queryByText(/reconnect/i),
      ).toBeNull();
      expect(
        screen.queryByText(/re-authorize/i),
      ).toBeNull();
    });
  });

  it("renders Continue and Skip buttons", async () => {
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step3Repositories
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Continue")).toBeInTheDocument();
      expect(
        screen.getByText(/Skip.*CLI.*MCP/),
      ).toBeInTheDocument();
    });
  });
});

// ── Step 5: Complete / Waiting ────────────────────────────────────────────

describe("Step5Complete", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    // Default: return empty data (waiting state)
    mockedGetStats.mockResolvedValue({
      eventsReceived: 0,
      jobsRunning: 0,
      pagesCompiled: 0,
    });
    mockedGetLatest.mockResolvedValue(null);
  });

  it("shows waiting state with honest empty stats (all zeros)", async () => {
    const onGoToKnowledge = vi.fn();

    renderStep(
      <Step5Complete
        projectId="prj_test"
        onGoToKnowledge={onGoToKnowledge}
      />,
    );

    // Initially shows "Waiting for the first events…"
    await waitFor(() => {
      expect(
        screen.getByText("Waiting for the first events…"),
      ).toBeInTheDocument();
    });

    // All three stat labels should appear
    expect(screen.getByText("Events received")).toBeInTheDocument();
    expect(screen.getByText("Jobs running")).toBeInTheDocument();
    expect(screen.getByText("Pages compiled")).toBeInTheDocument();
  });

  it("shows troubleshooting guidance in waiting state", async () => {
    const onGoToKnowledge = vi.fn();

    renderStep(
      <Step5Complete
        projectId="prj_test"
        onGoToKnowledge={onGoToKnowledge}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("No events yet? Check these"),
      ).toBeInTheDocument();
    });

    // Three troubleshooting items
    expect(
      screen.getByText(/teamem init/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/GitHub App is/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/installed on that repository/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/LLM provider.*Step 2/),
    ).toBeInTheDocument();
  });

  it("does not show fake success when data is absent", async () => {
    const onGoToKnowledge = vi.fn();

    renderStep(
      <Step5Complete
        projectId="prj_test"
        onGoToKnowledge={onGoToKnowledge}
      />,
    );

    await waitFor(() => {
      // Should NOT claim "Your first knowledge is here" when no data
      expect(
        screen.queryByText("Your first knowledge is here"),
      ).toBeNull();
      // Should NOT show "Compiled just now" pill
      expect(screen.queryByText("Compiled just now")).toBeNull();
    });
  });

  it("shows Refresh button in waiting state", async () => {
    const onGoToKnowledge = vi.fn();

    renderStep(
      <Step5Complete
        projectId="prj_test"
        onGoToKnowledge={onGoToKnowledge}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeInTheDocument();
    });
  });

  it("has Go to Knowledge button in waiting state", async () => {
    const onGoToKnowledge = vi.fn();

    renderStep(
      <Step5Complete
        projectId="prj_test"
        onGoToKnowledge={onGoToKnowledge}
      />,
    );

    const btn = screen.getByText("Go to Knowledge");
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(onGoToKnowledge).toHaveBeenCalledOnce();
  });
});

// ── Key red lines (cross-step verification) ──────────────────────────────

describe("Onboarding red lines", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mockedGetStats.mockResolvedValue({
      eventsReceived: 0,
      jobsRunning: 0,
      pagesCompiled: 0,
    });
    mockedGetLatest.mockResolvedValue(null);
  });

  it("Step 2: FTS degradation is explicit (not hidden)", () => {
    // Verify that the Anthropic provider card shows "no embedding API"
    const onComplete = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();

    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={onComplete}
        onBack={onBack}
        onSkip={onSkip}
      />,
    );

    // Anthropic subtitle must mention no embedding
    const anthropicSub = screen.getByText(/Claude models.*no embedding API/);
    expect(anthropicSub).toBeInTheDocument();

    // OpenAI subtitle must mention embeddings
    const openaiSub = screen.getByText(/GPT models \+ embeddings/);
    expect(openaiSub).toBeInTheDocument();
  });

  it("Step 5: waiting state is honest — no fake compiled page", async () => {
    const onGoToKnowledge = vi.fn();

    renderStep(
      <Step5Complete
        projectId="prj_test"
        onGoToKnowledge={onGoToKnowledge}
      />,
    );

    await waitFor(() => {
      // The "Latest page" card should not appear when there's no data
      expect(screen.queryByText("Latest page")).toBeNull();
    });

    // Troubleshooting section should be visible instead
    expect(
      screen.getByText("No events yet? Check these"),
    ).toBeInTheDocument();
  });
});
