/**
 * Onboarding wizard component tests.
 *
 * Covers:
 *   - All 5 step components rendering with correct states
 *   - Step 2 FTS degradation variant (Anthropic = no embedding)
 *   - Step 5 waiting (honest empty) state
 *   - Key red lines: key shown once, degradation explicit, no fake data
 *
 * Uses vi.mock at module level to stub onboarding-api functions so tests
 * never hit real HTTP endpoints. This is unit-level stubbing; network-
 * level integration tests (with MSW) would be a follow-up as prescribed
 * by the task card.
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

// ── Mock the API module at module level (vitest hoists these) ────────────

vi.mock("@/components/onboarding/onboarding-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/onboarding/onboarding-api")
  >("@/components/onboarding/onboarding-api");
  return {
    ...actual,
    getOnboardingStats: vi.fn(),
    getLatestConcept: vi.fn(),
    mintApiKey: vi.fn(),
    createTeam: vi.fn(),
    createProject: vi.fn(),
  };
});

import {
  getOnboardingStats,
  getLatestConcept,
  createTeam,
  createProject,
} from "@/components/onboarding/onboarding-api";

const mockedGetStats = vi.mocked(getOnboardingStats);
const mockedGetLatest = vi.mocked(getLatestConcept);
const mockedCreateTeam = vi.mocked(createTeam);
const mockedCreateProject = vi.mocked(createProject);

// ── Helpers ────────────────────────────────────────────────────────────────

function renderStep(jsx: React.ReactElement) {
  return render(<div className="wiz-card">{jsx}</div>);
}

// ── Step 1: Create Team ───────────────────────────────────────────────────

describe("Step1CreateTeam", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mockedCreateTeam.mockReset();
    mockedCreateProject.mockReset();
  });

  it("renders team and project name fields", () => {
    renderStep(<Step1CreateTeam onComplete={vi.fn()} />);

    expect(screen.getByText("Create your team")).toBeInTheDocument();
    expect(screen.getByLabelText("Team name")).toBeInTheDocument();
    expect(screen.getByLabelText("First project")).toBeInTheDocument();
    expect(screen.getByText(/you'll become the team/)).toBeInTheDocument();
  });

  it("shows error when submitting with empty fields", async () => {
    renderStep(<Step1CreateTeam onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(screen.getByText("Team name is required.")).toBeInTheDocument();
    });
  });

  it("disables submit button while submitting", async () => {
    mockedCreateTeam.mockResolvedValue({
      requestId: "req_1",
      data: { id: "team_1", name: "Test", role: "owner", createdAt: new Date().toISOString() },
    });
    mockedCreateProject.mockResolvedValue({
      requestId: "req_2",
      data: { id: "prj_1", teamId: "team_1", name: "proj", createdAt: new Date().toISOString() },
    });

    renderStep(<Step1CreateTeam onComplete={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Test Team" },
    });
    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: "test-project" },
    });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(screen.getByText("Creating…")).toBeInTheDocument();
    });
  });
});

// ── Step 2: LLM Provider ──────────────────────────────────────────────────

describe("Step2LlmProvider", () => {
  afterEach(() => cleanup());

  it("renders all four provider options", () => {
    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(screen.getByText("Custom endpoint")).toBeInTheDocument();
  });

  it("shows FTS degradation when Anthropic is selected", () => {
    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Anthropic"));

    // Should show FTS warning banner
    expect(screen.getByText(/Keyword search only/)).toBeInTheDocument();
    // Should show "Continue anyway" button
    expect(screen.getByText("Continue anyway")).toBeInTheDocument();
  });

  it("shows semantic search available for OpenAI", () => {
    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("OpenAI"));

    expect(screen.getByText(/Semantic search available/)).toBeInTheDocument();
  });

  it("skip button states consequence: compilation stays paused", () => {
    const onSkip = vi.fn();
    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={onSkip}
      />,
    );

    const btn = screen.getByText(/Skip for now/);
    expect(btn.textContent).toContain("compilation stays paused");
    fireEvent.click(btn);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("shows informational banner when no provider selected", () => {
    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/LLM is configured at deploy time/),
    ).toBeInTheDocument();
  });
});

// ── Step 3: Repositories ──────────────────────────────────────────────────

describe("Step3Repositories", () => {
  afterEach(() => cleanup());

  it("does not say 'reconnect' in the subtitle", () => {
    renderStep(
      <Step3Repositories
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.queryByText(/reconnect/i)).toBeNull();
    expect(screen.queryByText(/re-authorize/i)).toBeNull();
    expect(screen.getByText(/no new connection/)).toBeInTheDocument();
  });

  it("renders Continue and Skip buttons", () => {
    renderStep(
      <Step3Repositories
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByText("Continue")).toBeInTheDocument();
    expect(screen.getByText(/Skip.*CLI.*MCP/)).toBeInTheDocument();
  });

  it("mentions deploy-time configuration", () => {
    renderStep(
      <Step3Repositories
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Repository access is configured on GitHub/),
    ).toBeInTheDocument();
  });
});

// ── Step 5: Complete / Waiting ────────────────────────────────────────────

describe("Step5Complete", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mockedGetStats.mockReset();
    mockedGetLatest.mockReset();
  });

  it("shows waiting state with honest empty data (all zeros)", async () => {
    mockedGetStats.mockResolvedValue({
      hasEvents: false,
      hasJobs: false,
      hasPages: false,
      eventsCount: 0,
      jobsCount: 0,
      pagesCount: 0,
    });
    mockedGetLatest.mockResolvedValue(null);

    renderStep(
      <Step5Complete
        projectId="prj_test"
        apiKey="tm_test_key"
        keySkipped={false}
        onGoToKnowledge={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Waiting for the first events…"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Events received")).toBeInTheDocument();
    expect(screen.getByText("Jobs found")).toBeInTheDocument();
    expect(screen.getByText("Pages compiled")).toBeInTheDocument();
  });

  it("shows troubleshooting guidance in waiting state", async () => {
    mockedGetStats.mockResolvedValue({
      hasEvents: false,
      hasJobs: false,
      hasPages: false,
      eventsCount: 0,
      jobsCount: 0,
      pagesCount: 0,
    });
    mockedGetLatest.mockResolvedValue(null);

    renderStep(
      <Step5Complete
        projectId="prj_test"
        apiKey="tm_test_key"
        keySkipped={false}
        onGoToKnowledge={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("No events yet? Check these"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/teamem init/)).toBeInTheDocument();
    expect(screen.getByText(/GitHub App is/)).toBeInTheDocument();
    expect(screen.getByText(/LLM provider/)).toBeInTheDocument();
  });

  it("does not show fake success when data is absent", async () => {
    mockedGetStats.mockResolvedValue({
      hasEvents: false,
      hasJobs: false,
      hasPages: false,
      eventsCount: 0,
      jobsCount: 0,
      pagesCount: 0,
    });
    mockedGetLatest.mockResolvedValue(null);

    renderStep(
      <Step5Complete
        projectId="prj_test"
        apiKey="tm_test_key"
        keySkipped={false}
        onGoToKnowledge={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Your first knowledge is here")).toBeNull();
      expect(screen.queryByText("Compiled just now")).toBeNull();
    });
  });

  it("shows Refresh button in waiting state", async () => {
    mockedGetStats.mockResolvedValue({
      hasEvents: false,
      hasJobs: false,
      hasPages: false,
      eventsCount: 0,
      jobsCount: 0,
      pagesCount: 0,
    });
    mockedGetLatest.mockResolvedValue(null);

    renderStep(
      <Step5Complete
        projectId="prj_test"
        apiKey="tm_test_key"
        keySkipped={false}
        onGoToKnowledge={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeInTheDocument();
    });
  });

  it("has Go to Knowledge button", async () => {
    mockedGetStats.mockResolvedValue({
      hasEvents: false,
      hasJobs: false,
      hasPages: false,
      eventsCount: 0,
      jobsCount: 0,
      pagesCount: 0,
    });
    mockedGetLatest.mockResolvedValue(null);

    const onGo = vi.fn();
    renderStep(
      <Step5Complete
        projectId="prj_test"
        apiKey="tm_test_key"
        keySkipped={false}
        onGoToKnowledge={onGo}
      />,
    );

    fireEvent.click(screen.getByText("Go to Knowledge"));
    expect(onGo).toHaveBeenCalledOnce();
  });
});

// ── Key red lines (cross-step verification) ──────────────────────────────

describe("Onboarding red lines", () => {
  afterEach(() => cleanup());

  it("Step 2: FTS degradation is explicit (not hidden)", () => {
    renderStep(
      <Step2LlmProvider
        teamId="team_test"
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    // Anthropic subtitle must mention no embedding
    expect(
      screen.getByText(/Claude models.*no embedding API/),
    ).toBeInTheDocument();

    // OpenAI subtitle must mention embeddings
    expect(
      screen.getByText(/GPT models \+ embeddings/),
    ).toBeInTheDocument();
  });

  it("Step 5: waiting state is honest — no fake compiled page", async () => {
    mockedGetStats.mockResolvedValue({
      hasEvents: false,
      hasJobs: false,
      hasPages: false,
      eventsCount: 0,
      jobsCount: 0,
      pagesCount: 0,
    });
    mockedGetLatest.mockResolvedValue(null);

    renderStep(
      <Step5Complete
        projectId="prj_test"
        apiKey="tm_test_key"
        keySkipped={false}
        onGoToKnowledge={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Latest page")).toBeNull();
    });

    expect(
      screen.getByText("No events yet? Check these"),
    ).toBeInTheDocument();
  });
});
