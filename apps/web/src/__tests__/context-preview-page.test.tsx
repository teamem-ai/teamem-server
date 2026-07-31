import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ContextPreviewPage } from "@/pages/context-preview-page";
import { ScopeProvider } from "@/lib/scope";

/**
 * Context preview tests. Context mocks use the REAL server markdown format
 * (apps/server/src/http/routes/context.ts):
 *
 *   # Team Context
 *
 *   ## {title}
 *   {one-line summary}
 *
 *   [View details](teamem://concept/{uuid})
 *
 *   ---
 *
 *   ## {next}
 *
 * Empty projects return an italic placeholder message and
 * conceptsIncluded === 0 — the page must show the honest empty state.
 */

const mocks = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  fetchProjects: vi.fn(),
  fetchContext: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchMe: (...args: unknown[]) => mocks.fetchMe(...args),
  fetchProjects: (...args: unknown[]) => mocks.fetchProjects(...args),
  fetchContext: (...args: unknown[]) => mocks.fetchContext(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  },
}));

const MEMBER_SESSION = {
  userId: "usr_1",
  githubLogin: "dli",
  avatarUrl: null,
  teamId: "team_1",
  teamName: "Acme Corp",
  role: "member" as const,
};

const PROJECTS = [
  { id: "prj_webapp", teamId: "team_1", name: "web-app", createdAt: "2026-07-01T00:00:00Z" },
];

/** Real server-produced markdown (header + entries + separators). */
const REAL_MARKDOWN = [
  "# Team Context",
  "",
  "## Task Service - Manages Task CRUD Operations",
  "**service** · services/task",
  "Core service owning task lifecycle, validation and persistence.",
  "",
  "[View details](teamem://concept/aaaabbbb-cccc-dddd-eeee-eeeeeeeeeeee)",
  "",
  "---",
  "",
  "## Exponential backoff error handling warning",
  "**gotcha** · gotchas/backoff-error-handling",
  "The retry helper catches all errors including non-retryable ones.",
  "",
  "[View details](teamem://concept/11112222-3333-4444-5555-555555555555)",
  "",
  "---",
  "",
  "## PostgreSQL Connection Pool Shutdown",
  "**decision** · decisions/postgres-pool-shutdown",
  "Skipping pool.end() during graceful shutdown leaks connections.",
  "",
  "[View details](teamem://concept/66667777-8888-9999-0000-000000000000)",
  "",
].join("\n");

const CONTEXT_WITH_DATA = {
  requestId: "req_123",
  data: {
    markdown: REAL_MARKDOWN,
    budgetUsed: 450,
    conceptsIncluded: 3,
    conceptsAvailable: 15,
  },
};

/** Real empty-project response (server emits italic placeholder, not ""). */
const CONTEXT_EMPTY = {
  requestId: "req_456",
  data: {
    markdown:
      "# Team Context\n\n_No high-confidence team knowledge available yet. Concepts are compiled from ingested events — try adding data first._\n",
    budgetUsed: 30,
    conceptsIncluded: 0,
    conceptsAvailable: 0,
  },
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ScopeProvider>
        <ContextPreviewPage />
      </ScopeProvider>
    </MemoryRouter>,
  );
}

describe("ContextPreviewPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  function setupScope() {
    mocks.fetchMe.mockResolvedValue(MEMBER_SESSION);
    mocks.fetchProjects.mockResolvedValue(PROJECTS);
  }

  it("renders page header and fetches context for the real project", async () => {
    setupScope();
    mocks.fetchContext.mockResolvedValue(CONTEXT_WITH_DATA);
    renderPage();

    expect(await screen.findByText("Context preview")).toBeInTheDocument();
    expect(
      screen.getByText(/What your agent automatically knows/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.fetchContext).toHaveBeenCalledWith("prj_webapp"),
    );
  });

  it("shows the token budget indicator", async () => {
    setupScope();
    mocks.fetchContext.mockResolvedValue(CONTEXT_WITH_DATA);
    renderPage();
    expect(await screen.findByText(/450 \/ 800 tokens/)).toBeInTheDocument();
  });

  it("renders concept titles, summaries, type badges, and paths from the real server markdown", async () => {
    setupScope();
    mocks.fetchContext.mockResolvedValue(CONTEXT_WITH_DATA);
    renderPage();

    expect(
      await screen.findByText("Task Service - Manages Task CRUD Operations"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Exponential backoff error handling warning"),
    ).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL Connection Pool Shutdown")).toBeInTheDocument();
    expect(
      screen.getByText(/Core service owning task lifecycle/),
    ).toBeInTheDocument();
    // DUA-234: type badge and path are parsed from the server markdown
    expect(screen.getByText("services/task")).toBeInTheDocument();
    expect(screen.getByText("gotchas/backoff-error-handling")).toBeInTheDocument();
    expect(screen.getByText("decisions/postgres-pool-shutdown")).toBeInTheDocument();
  });

  it("links each item to its concept detail page using the UUID from the markdown", async () => {
    setupScope();
    mocks.fetchContext.mockResolvedValue(CONTEXT_WITH_DATA);
    renderPage();

    const taskLink = await screen.findByText(
      "Task Service - Manages Task CRUD Operations",
    );
    expect(taskLink.closest("a")).toHaveAttribute(
      "href",
      "/concept/aaaabbbb-cccc-dddd-eeee-eeeeeeeeeeee",
    );
  });

  it("renders the install-hook command and refresh button", async () => {
    setupScope();
    mocks.fetchContext.mockResolvedValue(CONTEXT_WITH_DATA);
    renderPage();

    expect(await screen.findByText("teamem cli install-hook")).toBeInTheDocument();
    expect(screen.getByText("Refresh")).toBeInTheDocument();
  });

  // ── Honest empty state (design: context-preview.html "Nothing to inject yet") ──

  it("shows 'Nothing to inject yet' when the server includes zero concepts", async () => {
    setupScope();
    mocks.fetchContext.mockResolvedValue(CONTEXT_EMPTY);
    renderPage();

    expect(await screen.findByText("Nothing to inject yet")).toBeInTheDocument();
    expect(screen.getByText(/Feed the compiler/)).toBeInTheDocument();
    // Must NOT show the summary card or the raw server placeholder text
    expect(screen.queryByText("Injected summary")).toBeNull();
    expect(screen.queryByText(/recognizable concept items/)).toBeNull();
  });

  // ── Error state ──

  it("shows error banner on failure", async () => {
    setupScope();
    mocks.fetchContext.mockRejectedValue(new Error("Failed to load context preview"));
    renderPage();

    expect(
      await screen.findByText("Failed to load context preview"),
    ).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  // ── Signed out ──

  it("shows sign-in prompt when there is no session", async () => {
    const { ApiError } = await import("@/lib/api");
    mocks.fetchMe.mockRejectedValue(new ApiError(401, "unauthorized", "no session"));
    renderPage();

    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
    expect(mocks.fetchContext).not.toHaveBeenCalled();
  });
});
