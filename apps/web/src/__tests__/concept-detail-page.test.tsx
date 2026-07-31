import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConceptDetailPage } from "@/pages/concept-detail-page";
import { ScopeProvider } from "@/lib/scope";

/**
 * Detail page tests. The api module is mocked — fetchConcept returns the
 * already-unwrapped Concept (the envelope unwrap is covered in api.test.ts).
 * Scope resolution uses the real ScopeProvider with mocked session endpoints.
 */

const mocks = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  fetchProjects: vi.fn(),
  fetchConcept: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchMe: (...args: unknown[]) => mocks.fetchMe(...args),
  fetchProjects: (...args: unknown[]) => mocks.fetchProjects(...args),
  fetchConcept: (...args: unknown[]) => mocks.fetchConcept(...args),
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

const threeEvidenceConcept = {
  schemaVersion: 1 as const,
  uuid: "13ee5d2e-6bfe-4406-ae91-153c4c0ea148",
  path: "decisions/use-postgresql-pgvector",
  type: "decision" as const,
  status: "active" as const,
  confidence: "high" as const,
  title: "Use PostgreSQL with pgvector and pg-boss for Queue Management",
  tags: ["postgresql", "pgvector", "decision", "database"],
  body: "### Context\n\nWe needed a primary datastore.\n\n### Decision\n\nWe chose PostgreSQL. Additionally, [pg-boss](teamem://concept/70de6dde-2ab5-4917-97c2-2013ab91cf95) is used for the compile queue.\n\n### Rationale\n\n1. **Single operational dependency.** Simple.",
  evidence: [
    {
      kind: "pr" as const,
      ref: "https://github.com/teamem-ai/teamem-server/pull/107",
      at: "2026-07-28T02:00:00.000Z",
    },
    {
      kind: "commit" as const,
      ref: "https://github.com/teamem-ai/teamem-server/commit/4f3a91c27b6d8e50a1c4f9b2e7d3a6c8b0f5e214",
      at: "2026-07-28T02:00:00.000Z",
    },
    {
      kind: "repo_file" as const,
      repo: "teamem-ai/teamem-server",
      commitSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      path: "docs/decisions/001-use-postgres-pgvector.md",
      at: "2026-07-28T04:02:17.218Z",
    },
  ],
  contributors: [
    {
      principalId: "pri_bcd9a86463a14104beced114bf645ad5",
      kind: "human" as const,
      provider: "github",
      displayName: "dli",
      githubLogin: "dli",
      avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      userId: "usr_dli",
    },
    {
      principalId: "pri_ac57a5e07cd94af0aec6b08819cb7422",
      kind: "service" as const,
      provider: "github-action",
      displayName: "github-action",
    },
  ],
  supersedes: null,
  aliases: [],
  firstSeen: "2026-07-28T04:02:17.218Z",
  lastConfirmed: "2026-07-28T04:03:20.624Z",
  createdAt: "2026-07-28T04:02:22.374Z",
};

const disputedConcept = {
  ...threeEvidenceConcept,
  uuid: "70de6dde-2ab5-4917-97c2-2013ab91cf95",
  path: "decisions/use-pg-boss-on-postgres",
  title: "Decision: Queue Technology Choice for Compile Queue",
  status: "disputed" as const,
  confidence: "high" as const,
  body: "### Position 1: Use pg-boss on Postgres\n\nSome text.\n\n### Position 2: Move compile queue to Redis\n\nSome other text.",
  evidence: [
    {
      kind: "repo_file" as const,
      repo: "teamem-ai/teamem-server",
      commitSha: "9c8d2e1f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d",
      path: "docs/decisions/queue-on-postgres.md",
      at: "2026-07-28T03:05:11.077Z",
    },
    {
      kind: "repo_file" as const,
      repo: "teamem-ai/teamem-server",
      commitSha: "7f2b9a4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a",
      path: "docs/decisions/queue-to-redis.md",
      at: "2026-07-28T03:06:41.188Z",
    },
  ],
  contributors: [
    {
      principalId: "pri_unbound_human",
      kind: "human" as const,
      provider: "github",
      displayName: "legacy-coder",
    },
  ],
};

const mcpConcept = {
  ...threeEvidenceConcept,
  uuid: "711d3989-06b8-46d2-9856-d05c2ab8b57e",
  path: "gotchas/stripe-webhook-retries",
  type: "gotcha" as const,
  title: "Stripe webhook retries and the risk of double charges",
  status: "active" as const,
  confidence: "medium" as const,
  body: "Stripe webhooks may retry delivery for up to three days.",
  tags: ["stripe", "idempotency", "webhooks"],
  evidence: [
    {
      kind: "mcp_write" as const,
      ref: "evt_53014880b618482c94dc28ac167acee9",
      at: "2026-07-28T12:19:43.225Z",
    },
  ],
  contributors: [],
};

function renderConcept(uuid: string) {
  return render(
    <MemoryRouter initialEntries={[`/concept/${uuid}`]}>
      <ScopeProvider>
        <Routes>
          <Route path="/concept/:uuid" element={<ConceptDetailPage />} />
        </Routes>
      </ScopeProvider>
    </MemoryRouter>,
  );
}

describe("ConceptDetailPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  function setupScope() {
    mocks.fetchMe.mockResolvedValue(MEMBER_SESSION);
    mocks.fetchProjects.mockResolvedValue(PROJECTS);
  }

  // ── Three-evidence decision page ──

  it("renders title, badges, and confidence for a decision page", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(threeEvidenceConcept);
    renderConcept(threeEvidenceConcept.uuid);

    expect(
      await screen.findByText(
        "Use PostgreSQL with pgvector and pg-boss for Queue Management",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Decision").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("fetches with the real session project ID", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(threeEvidenceConcept);
    renderConcept(threeEvidenceConcept.uuid);
    await screen.findByText(/Use PostgreSQL/);
    expect(mocks.fetchConcept).toHaveBeenCalledWith(
      threeEvidenceConcept.uuid,
      "prj_webapp",
    );
  });

  it("renders path, three timestamps, and UUID — never 'Updated'", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(threeEvidenceConcept);
    renderConcept(threeEvidenceConcept.uuid);

    expect(
      await screen.findByText("decisions/use-postgresql-pgvector"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/Created/)).toBeInTheDocument();
    expect(screen.getByText(/UUID 13ee5d2e/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Updated ");
  });

  it("renders the markdown body and converts [text](teamem://uuid) to internal links", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(threeEvidenceConcept);
    renderConcept(threeEvidenceConcept.uuid);
    await screen.findByText(/Use PostgreSQL with pgvector/);

    const bodyDiv = document.querySelector(".md");
    expect(bodyDiv?.innerHTML).toContain("Context");
    expect(bodyDiv?.innerHTML).toContain("Rationale");

    // teamem:// markdown link becomes an internal /concept/<uuid> anchor
    // with visible text — no raw brackets or unclosed tags.
    const ilink = bodyDiv?.querySelector('a[data-teamem-href]');
    expect(ilink).toBeTruthy();
    expect(ilink?.getAttribute("href")).toBe(
      "/concept/70de6dde-2ab5-4917-97c2-2013ab91cf95",
    );
    expect(ilink?.textContent).toBe("pg-boss");
    expect(bodyDiv?.innerHTML).not.toContain("[pg-boss]");
    expect(bodyDiv?.innerHTML).not.toContain("](teamem://");
  });

  it("renders evidence items by kind with correct labels", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(threeEvidenceConcept);
    renderConcept(threeEvidenceConcept.uuid);

    expect(await screen.findByText("Evidence · 3")).toBeInTheDocument();
    expect(screen.getByText("Pull request")).toBeInTheDocument();
    expect(screen.getByText("Commit")).toBeInTheDocument();
    expect(screen.getByText("Repo file")).toBeInTheDocument();
    // repo_file shows commit-pinned reference
    expect(screen.getByText(/commit-pinned/)).toBeInTheDocument();
    expect(
      screen.getByText(/a1b2c3d · docs\/decisions\/001-use-postgres-pgvector.md/),
    ).toBeInTheDocument();
  });

  it("renders contributors with the three forms: bound human, service, and unbound human", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(threeEvidenceConcept);
    renderConcept(threeEvidenceConcept.uuid);

    expect(await screen.findByText("Contributors · 2")).toBeInTheDocument();
    // Bound human: shows GitHub login
    expect(screen.getByText("@dli")).toBeInTheDocument();
    // Service: shows provider label (displayName + provider subtext)
    expect(screen.getAllByText("github-action").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("GitHub account")).toBeInTheDocument();
  });

  it("links bound GitHub contributors to internal member profile when userId is present", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(threeEvidenceConcept);
    renderConcept(threeEvidenceConcept.uuid);

    await screen.findByText("Contributors · 2");
    // dli has userId: "usr_dli" → should link to internal member profile
    const link = screen.getByText("@dli").closest("a");
    expect(link).toHaveAttribute("href", "/members/usr_dli");
    // Internal link, not blank target
    expect(link).not.toHaveAttribute("target", "_blank");
  });

  it("falls back to GitHub profile when contributor has no userId", async () => {
    setupScope();
    // dli without userId
    const noUserConcept = {
      ...threeEvidenceConcept,
      contributors: [
        {
          principalId: "pri_no_user",
          kind: "human" as const,
          provider: "github",
          displayName: "somebody",
          githubLogin: "somebody",
          avatarUrl: "https://avatars.githubusercontent.com/u/99999",
        },
        ...threeEvidenceConcept.contributors.slice(1),
      ],
    };
    mocks.fetchConcept.mockResolvedValue(noUserConcept);
    renderConcept(noUserConcept.uuid);

    await screen.findByText("@somebody");
    const ghLink = screen.getByText("@somebody").closest("a");
    expect(ghLink).toHaveAttribute("href", "https://github.com/somebody");
    expect(ghLink).toHaveAttribute("target", "_blank");
  });

  it("renders unbound human contributor without a GitHub account link", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(disputedConcept);
    renderConcept(disputedConcept.uuid);

    expect(await screen.findByText("Contributors · 1")).toBeInTheDocument();
    expect(screen.getByText("legacy-coder")).toBeInTheDocument();
    expect(screen.getByText("Unbound human contributor")).toBeInTheDocument();
    expect(screen.queryByText("GitHub account")).toBeNull();
  });

  it("includes a back link to knowledge", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(threeEvidenceConcept);
    renderConcept(threeEvidenceConcept.uuid);
    const backLink = await screen.findByText("Knowledge");
    expect(backLink.closest("a")).toHaveAttribute("href", "/knowledge");
  });

  // ── Disputed page ──

  it("shows 'Conflicting evidence — disputed' banner, keeps High confidence", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(disputedConcept);
    renderConcept(disputedConcept.uuid);

    expect(await screen.findByText(/Conflicting evidence/)).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.queryByText("Low")).toBeNull();
  });

  it("renders the disabled Reconciliation button with SOON badge", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(disputedConcept);
    renderConcept(disputedConcept.uuid);

    await screen.findByText(/Conflicting evidence/);
    expect(screen.getByText("SOON")).toBeInTheDocument();
    const btn = screen.getByText("Reconciliation").closest("button");
    expect(btn).toBeDisabled();
  });

  it("shows the both-positions disclaimer on disputed pages", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(disputedConcept);
    renderConcept(disputedConcept.uuid);

    await screen.findByText(/Conflicting evidence/);
    expect(
      screen.getByText(/Both positions were compiled from separate repo files/),
    ).toBeInTheDocument();
  });

  // ── MCP evidence + empty contributors ──

  it("shows mcp_write evidence as internal event without external permalink", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(mcpConcept);
    renderConcept(mcpConcept.uuid);

    await screen.findByText(/Stripe webhook retries/);
    expect(screen.getAllByText("Agent write (MCP)").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/internal event/)).toBeInTheDocument();
    // mcp_write links to the internal event detail page (not an external URL)
    const evRefs = screen.getAllByText("evt_53014880b618482c94dc28ac167acee9");
    const linked = evRefs.find((el) => el.closest("a") !== null);
    expect(linked?.closest("a")?.getAttribute("href")).toBe(
      "/events/evt_53014880b618482c94dc28ac167acee9",
    );
  });

  it("shows mcp-specific empty contributors message", async () => {
    setupScope();
    mocks.fetchConcept.mockResolvedValue(mcpConcept);
    renderConcept(mcpConcept.uuid);

    await screen.findByText(/Stripe webhook retries/);
    expect(screen.getByText("Contributors · 0")).toBeInTheDocument();
    expect(
      screen.getByText(/Agent writes via MCP are attributed to the invoking principal/),
    ).toBeInTheDocument();
  });

  it("shows disputed-specific empty contributors message", async () => {
    setupScope();
    const disputedEmpty = {
      ...disputedConcept,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      contributors: [],
    };
    mocks.fetchConcept.mockResolvedValue(disputedEmpty);
    renderConcept(disputedEmpty.uuid);

    await screen.findByText(/Conflicting evidence/);
    expect(screen.getByText("Contributors · 0")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Both positions were compiled from separate repo files/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  // ── 404 (unified, no access hints) ──

  it("shows the unified 404 for missing/cross-team concepts", async () => {
    setupScope();
    const { ApiError } = await import("@/lib/api");
    mocks.fetchConcept.mockRejectedValue(new ApiError(404, "not_found", "Concept not found"));
    renderConcept("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(screen.queryByText(/access/i)).toBeNull();
    expect(screen.queryByText(/permission/i)).toBeNull();
  });

  // ── Error state ──

  it("shows error banner with retry on failure", async () => {
    setupScope();
    mocks.fetchConcept.mockRejectedValue(new Error("Network failure"));
    renderConcept(threeEvidenceConcept.uuid);

    expect(await screen.findByText("Failed to load concept page")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  // ── Signed out ──

  it("shows sign-in prompt when there is no session", async () => {
    const { ApiError } = await import("@/lib/api");
    mocks.fetchMe.mockRejectedValue(new ApiError(401, "unauthorized", "no session"));
    renderConcept(threeEvidenceConcept.uuid);

    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
    expect(mocks.fetchConcept).not.toHaveBeenCalled();
  });
});
