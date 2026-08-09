import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { KnowledgePage } from "@/pages/knowledge-page";
import { ScopeProvider } from "@/lib/scope";

/**
 * Page tests mock @/lib/api at the module boundary. The ScopeProvider is
 * real — it resolves scope from the mocked session endpoints exactly as in
 * production. All data mocks use the REAL server envelope shapes:
 *   - listResponse:   { requestId, data, nextCursor }
 *   - searchResponse: { requestId, results, degraded, nextCursor } (flat)
 *   - GET /auth/me:   flat session object
 *   - projects:       { requestId, data: [...] }
 *
 * ConceptSummary mocks include the DUA-234 additive fields
 * (evidenceCount, contributors) as returned by the real server.
 */

const mocks = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  fetchProjects: vi.fn(),
  fetchConcepts: vi.fn(),
  searchConcepts: vi.fn(),
  downloadExportFile: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchMe: (...args: unknown[]) => mocks.fetchMe(...args),
  fetchProjects: (...args: unknown[]) => mocks.fetchProjects(...args),
  fetchConcepts: (...args: unknown[]) => mocks.fetchConcepts(...args),
  searchConcepts: (...args: unknown[]) => mocks.searchConcepts(...args),
  downloadExportFile: (...args: unknown[]) => mocks.downloadExportFile(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    details?: unknown;
    constructor(status: number, code: string, message: string, details?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
  AuditWriteFailedError: class AuditWriteFailedError extends Error {
    status: number;
    code: string;
    details?: unknown;
    constructor(status: number, code: string, message: string, details?: unknown) {
      super(message);
      this.name = "AuditWriteFailedError";
      this.status = status;
      this.code = code;
      this.details = details;
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

const VIEWER_SESSION = { ...MEMBER_SESSION, role: "viewer" as const };

const PROJECTS = [
  { id: "prj_webapp", teamId: "team_1", name: "web-app", createdAt: "2026-07-01T00:00:00Z" },
];

const MOCK_CONTRIBUTORS = [
  {
    principalId: "pri_dli_bound",
    kind: "human" as const,
    provider: "github",
    displayName: "dli",
    githubLogin: "dli",
    avatarUrl: "https://avatars.githubusercontent.com/u/12345",
  },
  {
    principalId: "pri_service",
    kind: "service" as const,
    provider: "github-action",
    displayName: "github-action",
  },
];

const MOCK_SUMMARIES = [
  {
    uuid: "13ee5d2e-6bfe-4406-ae91-153c4c0ea148",
    path: "decisions/use-postgresql-pgvector",
    type: "decision",
    status: "active",
    confidence: "high",
    title: "Use PostgreSQL with pgvector and pg-boss",
    tags: ["postgresql", "pgvector"],
    lastConfirmed: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    evidenceCount: 3,
    contributors: MOCK_CONTRIBUTORS,
  },
  {
    uuid: "70de6dde-2ab5-4917-97c2-2013ab91cf95",
    path: "decisions/use-pg-boss-for-compile-queue",
    type: "decision",
    status: "disputed",
    confidence: "high",
    title: "Decision on Compile Queue: Redis vs. Postgres",
    tags: ["queue", "pg-boss"],
    lastConfirmed: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    evidenceCount: 2,
    contributors: [],
  },
  {
    uuid: "711d3989-06b8-46d2-9856-d05c2ab8b57e",
    path: "gotchas/stripe-webhook-retries",
    type: "gotcha",
    status: "active",
    confidence: "medium",
    title: "Stripe webhook retries and the risk of double charges",
    tags: ["stripe"],
    lastConfirmed: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    evidenceCount: 1,
    contributors: [MOCK_CONTRIBUTORS[0]!],
  },
];

type TestSession = Omit<typeof MEMBER_SESSION, "role"> & {
  role: "owner" | "admin" | "member" | "viewer";
};

function setupScope(session: TestSession = MEMBER_SESSION) {
  mocks.fetchMe.mockResolvedValue(session);
  mocks.fetchProjects.mockResolvedValue(PROJECTS);
}

function renderPage(initialPath = "/knowledge") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ScopeProvider>
        <KnowledgePage />
      </ScopeProvider>
    </MemoryRouter>,
  );
}

describe("KnowledgePage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  // ── Scope-driven states ──

  it("loads concepts for the real session project (not a hardcoded ID)", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    renderPage();
    await screen.findByText("No knowledge yet");
    expect(mocks.fetchConcepts).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "prj_webapp" }),
    );
  });

  it("shows sign-in prompt when the session is missing (401)", async () => {
    const { ApiError } = await import("@/lib/api");
    mocks.fetchMe.mockRejectedValue(new ApiError(401, "unauthorized", "no session"));
    renderPage();
    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
    expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    // No data fetch must happen without a session
    expect(mocks.fetchConcepts).not.toHaveBeenCalled();
  });

  // ── List state ──

  it("renders page header", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    renderPage();
    expect(await screen.findByText("Knowledge")).toBeInTheDocument();
    expect(
      screen.getByText(/Team knowledge compiled from real development activity/),
    ).toBeInTheDocument();
  });

  it("renders concept rows with type badge, title, path, evidence count, last confirmed, confidence, and contributor avatars", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({
      requestId: "r",
      data: MOCK_SUMMARIES,
      nextCursor: null,
    });
    renderPage();

    expect(
      await screen.findByText("Use PostgreSQL with pgvector and pg-boss"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Decision on Compile Queue: Redis vs. Postgres"),
    ).toBeInTheDocument();
    expect(screen.getByText("decisions/use-postgresql-pgvector")).toBeInTheDocument();
    expect(screen.getByText("3 evidence")).toBeInTheDocument();
    expect(screen.getByText("1 evidence")).toBeInTheDocument();
    const confirmed = await screen.findAllByText(/Last confirmed/);
    expect(confirmed.length).toBe(3);
    // Disputed row shows the status badge (also appears in the filter dropdown)
    expect(screen.getAllByText("Disputed").length).toBeGreaterThanOrEqual(2);
    // Avatar stack rendered
    expect(document.querySelectorAll("[aria-label='Contributors']").length).toBe(3);
  });

  it("disputed concept keeps high confidence (never rendered as low)", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({
      requestId: "r",
      data: MOCK_SUMMARIES,
      nextCursor: null,
    });
    renderPage();
    await screen.findByText("Decision on Compile Queue: Redis vs. Postgres");
    const row = screen
      .getByText("Decision on Compile Queue: Redis vs. Postgres")
      .closest("a");
    expect(row?.textContent).toContain("High");
    expect(row?.textContent).not.toContain("Low");
  });

  it("shows empty state with honest CTAs when no concepts exist", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    renderPage();
    expect(await screen.findByText("No knowledge yet")).toBeInTheDocument();
    expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    expect(screen.getByText("Run teamem init")).toBeInTheDocument();
  });

  it("shows Load more when nextCursor is present", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({
      requestId: "r",
      data: MOCK_SUMMARIES,
      nextCursor: "cursor_123",
    });
    renderPage();
    expect(await screen.findByText("Load more")).toBeInTheDocument();
  });

  it("shows error banner when the list fetch fails", async () => {
    setupScope();
    mocks.fetchConcepts.mockRejectedValue(new Error("Network error"));
    renderPage();
    expect(await screen.findByText("Failed to load concepts")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  // ── Filters (contract params only: type/status/tag/contributor) ──

  it("renders type/status selects and tag/contributor inputs (no confidence filter)", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    renderPage();
    await screen.findByText("Knowledge");
    const selects = document.querySelectorAll("select.filter-chip");
    expect(selects.length).toBe(2); // type + status only
    expect(screen.getByLabelText("Filter by tag")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by contributor principal ID")).toBeInTheDocument();
    // No confidence filter — not a contract param
    expect(document.body.textContent).not.toContain("All confidence");
  });

  it("viewer session sees only Type and Status filters", async () => {
    setupScope(VIEWER_SESSION);
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: MOCK_SUMMARIES, nextCursor: null });
    renderPage();
    await screen.findByText("Knowledge");
    const selects = document.querySelectorAll("select.filter-chip");
    expect(selects.length).toBe(2); // type + status only
    expect(screen.queryByLabelText("Filter by tag")).toBeNull();
    expect(screen.queryByLabelText("Filter by contributor principal ID")).toBeNull();
  });

  it("shows skeleton rows while loading the list", async () => {
    setupScope();
    // Never resolve — keeps loading state
    mocks.fetchConcepts.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(await screen.findByText("Knowledge")).toBeInTheDocument();
    expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("initializes the tag filter from the URL query param", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    renderPage("/knowledge?tag=postgresql");
    await waitFor(() => {
      expect(mocks.fetchConcepts).toHaveBeenCalledWith(
        expect.objectContaining({ tag: "postgresql" }),
      );
    });
  });

  // ── Search ──

  const MOCK_SEARCH_RESULTS = {
    requestId: "req_search",
    results: [
      {
        uuid: "13ee5d2e-6bfe-4406-ae91-153c4c0ea148",
        path: "decisions/use-postgresql-pgvector",
        type: "decision",
        status: "active",
        confidence: "high",
        title: "Use PostgreSQL with pgvector and pg-boss",
        tags: ["postgresql", "pgvector"],
        lastConfirmed: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        evidenceCount: 3,
        contributors: [],
        relevance: 0.36,
        ftsFallback: false,
      },
    ],
    degraded: false,
    nextCursor: null,
  };

  it("has a search bar for member role", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    renderPage();
    expect(
      await screen.findByPlaceholderText(/Ask in natural language/),
    ).toBeInTheDocument();
  });

  it("triggers semantic search and renders results", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    mocks.searchConcepts.mockResolvedValue(MOCK_SEARCH_RESULTS);
    renderPage();

    const input = await screen.findByPlaceholderText(/Ask in natural language/);
    fireEvent.change(input, { target: { value: "why postgres" } });
    fireEvent.click(screen.getByText("Search"));

    expect(
      await screen.findByText("Use PostgreSQL with pgvector and pg-boss"),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 result for/)).toBeInTheDocument();
    expect(screen.getByText(/semantic/)).toBeInTheDocument();
    expect(screen.getByText("Top match first")).toBeInTheDocument();
    expect(mocks.searchConcepts).toHaveBeenCalledWith(
      expect.objectContaining({ query: "why postgres" }),
    );
  });

  it("does not render relevance as a percentage", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    mocks.searchConcepts.mockResolvedValue(MOCK_SEARCH_RESULTS);
    renderPage();

    const input = await screen.findByPlaceholderText(/Ask in natural language/);
    fireEvent.change(input, { target: { value: "why postgres" } });
    fireEvent.click(screen.getByText("Search"));
    await screen.findByText("Use PostgreSQL with pgvector and pg-boss");

    expect(document.body.textContent).not.toContain("36%");
    expect(document.body.textContent).not.toContain("0.36");
  });

  it("shows degraded banner and keyword label when search degraded", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    mocks.searchConcepts.mockResolvedValue({
      ...MOCK_SEARCH_RESULTS,
      degraded: true,
      results: [
        {
          ...MOCK_SEARCH_RESULTS.results[0]!,
          ftsFallback: true,
        },
      ],
    });
    renderPage();

    const input = await screen.findByPlaceholderText(/Ask in natural language/);
    fireEvent.change(input, { target: { value: "why postgres" } });
    fireEvent.click(screen.getByText("Search"));

    expect(await screen.findByText("Keyword search only")).toBeInTheDocument();
    expect(screen.getByText(/keyword/)).toBeInTheDocument();
  });

  it("shows empty state when search returns no results", async () => {
    setupScope();
    mocks.fetchConcepts.mockResolvedValue({ requestId: "r", data: [], nextCursor: null });
    mocks.searchConcepts.mockResolvedValue({
      requestId: "req_search",
      results: [],
      degraded: false,
      nextCursor: null,
    });
    renderPage();

    const input = await screen.findByPlaceholderText(/Ask in natural language/);
    fireEvent.change(input, { target: { value: "nonexistent query" } });
    fireEvent.click(screen.getByText("Search"));

    expect(await screen.findByText("No pages match your search")).toBeInTheDocument();
  });

  // ── Viewer (real role from session) ──

  it("viewer session sees the list but NO search box", async () => {
    setupScope(VIEWER_SESSION);
    mocks.fetchConcepts.mockResolvedValue({
      requestId: "r",
      data: MOCK_SUMMARIES,
      nextCursor: null,
    });
    renderPage();

    // List renders
    expect(
      await screen.findByText("Use PostgreSQL with pgvector and pg-boss"),
    ).toBeInTheDocument();
    // Viewer guidance banner
    expect(screen.getByText(/browsing as a/)).toBeInTheDocument();
    // No search input, no search button
    expect(screen.queryByPlaceholderText(/Ask in natural language/)).toBeNull();
    expect(screen.queryByText("Search")).toBeNull();
  });
});
