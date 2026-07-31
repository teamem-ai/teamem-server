import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SettingsLayout } from "@/pages/settings-layout";
import { SettingsKeysPage } from "@/pages/settings-keys-page";
import { SettingsSourcesPage } from "@/pages/settings-sources-page";
import { SettingsLlmPage } from "@/pages/settings-llm-page";
import { SettingsProjectPage } from "@/pages/settings-project-page";
import { SettingsTeamPage } from "@/pages/settings-team-page";

// ── Mock useSession — all pages call this; tests inject the desired role ──

let mockSessionRole: string = "owner";
let mockTeamId: string | null = "team_test";
let mockProjectId: string | null = "prj_test";

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    teamId: mockTeamId,
    role: mockSessionRole,
    projectId: mockProjectId,
  }),
}));

// ── Mock useScope — settings pages route through useSession, which we mock ──
// (no-op: useSession is already mocked above)

// ── Mock helpers ────────────────────────────────────────────────────────────

function mockFetchResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ requestId: "test", data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock fetch to return empty list + empty projects for keys/sources pages. */
function mockEmptyLists() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((url: string | URL | Request) => {
      const urlStr =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("/projects")) {
        return Promise.resolve(mockFetchResponse([]) as Response);
      }
      if (urlStr.includes("/connectors")) {
        return Promise.resolve(
          mockFetchResponse({
            github: {
              connected: false,
              appName: null,
              installedOn: null,
              repositories: [],
              webhookSecretConfigured: false,
              recentDeliveries: [],
            },
            cli: {
              lastInit: { at: null, repo: null, commitSha: null, eventsCount: 0, pagesCount: 0 },
              activeKeysWithWrite: 0,
            },
            mcp: {
              endpointHealthy: true,
              activeKeysWithWrite: 0,
            },
          }) as Response
        );
      }
      if (urlStr.includes("/teams/mine")) {
        return Promise.resolve(
          mockFetchResponse([{ id: "team_test", name: "Test Team", role: mockSessionRole }]) as Response
        );
      }
      if (urlStr.includes("/llm")) {
        return Promise.resolve(
          mockFetchResponse({
            provider: null,
            hasKey: false,
            lastTest: null,
            semanticRetrieval: { available: false, mode: "fts-only", reason: null },
          }) as Response
        );
      }
      return Promise.resolve(mockFetchResponse([]) as Response);
    });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderPage(Page: React.ComponentType) {
  return render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>
  );
}

// ── SettingsLayout ──────────────────────────────────────────────────────────

describe("SettingsLayout", () => {
  afterEach(() => cleanup());

  it("renders all five tab links", () => {
    render(
      <MemoryRouter initialEntries={["/settings/keys"]}>
        <SettingsLayout />
      </MemoryRouter>
    );
    expect(screen.getByText("API keys")).toBeInTheDocument();
    expect(screen.getByText("Ingestion")).toBeInTheDocument();
    expect(screen.getByText("LLM & retrieval")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("marks the active tab based on current route", () => {
    render(
      <MemoryRouter initialEntries={["/settings/keys"]}>
        <SettingsLayout />
      </MemoryRouter>
    );
    const keysTab = screen.getByText("API keys");
    expect(keysTab.className).toContain("border-accent");
  });
});

// ── SettingsKeysPage ────────────────────────────────────────────────────────

describe("SettingsKeysPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    mockSessionRole = "owner";
    mockTeamId = "team_test";
    mockProjectId = "prj_test";
  });

  it("renders the page header", async () => {
    mockEmptyLists();
    renderPage(SettingsKeysPage);
    expect(screen.getByText("API keys")).toBeInTheDocument();
    expect(screen.getByText(/Keys carry data-plane scopes/)).toBeInTheDocument();
  });

  it("shows the Mint button for admin+", async () => {
    mockSessionRole = "admin";
    mockEmptyLists();
    renderPage(SettingsKeysPage);
    expect(screen.getByText("Mint API key")).toBeInTheDocument();
  });

  it("shows empty state when no keys are present", async () => {
    mockEmptyLists();
    renderPage(SettingsKeysPage);
    await waitFor(() => {
      expect(screen.getByText("No keys minted yet")).toBeInTheDocument();
    });
  });

  it("shows the key safety notice at the bottom", async () => {
    mockEmptyLists();
    renderPage(SettingsKeysPage);
    await waitFor(() => {
      expect(
        screen.getByText(/Key IDs.*are identifiers, safe to display/)
      ).toBeInTheDocument();
    });
  });

  it("hides management actions when viewer", async () => {
    mockSessionRole = "viewer";
    mockEmptyLists();
    renderPage(SettingsKeysPage);
    await waitFor(() => {
      expect(screen.getByText(/Higher role required/)).toBeInTheDocument();
    });
    expect(screen.queryByText("Mint API key")).toBeNull();
  });

  it("shows no keys when teamId is null (not in a team)", async () => {
    mockTeamId = null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    renderPage(SettingsKeysPage);
    await waitFor(() => {
      expect(screen.getByText("No keys minted yet")).toBeInTheDocument();
    });
  });
});

// ── SettingsSourcesPage ─────────────────────────────────────────────────────

describe("SettingsSourcesPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    mockSessionRole = "owner";
    mockTeamId = "team_test";
  });

  it("renders the page header", () => {
    mockEmptyLists();
    renderPage(SettingsSourcesPage);
    expect(screen.getByText("Ingestion sources")).toBeInTheDocument();
  });

  it("shows GitHub App card", async () => {
    mockEmptyLists();
    renderPage(SettingsSourcesPage);
    await waitFor(() => {
      expect(screen.getByText("GitHub App")).toBeInTheDocument();
    });
  });

  it("shows CLI and MCP cards", async () => {
    mockEmptyLists();
    renderPage(SettingsSourcesPage);
    await waitFor(() => {
      expect(screen.getByText(/CLI.*teamem init/)).toBeInTheDocument();
      expect(screen.getByText(/MCP.*agent writes/)).toBeInTheDocument();
    });
  });

  it("shows endpoint healthy status", async () => {
    mockEmptyLists();
    renderPage(SettingsSourcesPage);
    await waitFor(() => {
      expect(screen.getByText("Endpoint healthy")).toBeInTheDocument();
    });
  });
});

// ── SettingsLlmPage ─────────────────────────────────────────────────────────

describe("SettingsLlmPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    mockSessionRole = "owner";
    mockTeamId = "team_test";
  });

  it("renders the page header", async () => {
    mockEmptyLists();
    renderPage(SettingsLlmPage);
    expect(screen.getByText("LLM & retrieval")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("LLM provider")).toBeInTheDocument();
    });
  });

  it("shows semantic retrieval status section", async () => {
    mockEmptyLists();
    renderPage(SettingsLlmPage);
    await waitFor(() => {
      expect(screen.getByText("Semantic retrieval")).toBeInTheDocument();
    });
  });

  it("shows compilation section as placeholder", async () => {
    mockEmptyLists();
    renderPage(SettingsLlmPage);
    await waitFor(() => {
      expect(screen.getByText("Compilation")).toBeInTheDocument();
    });
  });

  it("shows fts-only mode when no embedding is available", async () => {
    mockEmptyLists();
    renderPage(SettingsLlmPage);
    await waitFor(() => {
      expect(screen.getByText(/Unavailable — keyword/)).toBeInTheDocument();
    });
  });

  it("hides provider management from viewer", async () => {
    mockSessionRole = "viewer";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse({
        provider: null,
        hasKey: false,
        lastTest: null,
        semanticRetrieval: { available: false, mode: "fts-only", reason: null },
      }) as Response
    );
    renderPage(SettingsLlmPage);
    await waitFor(() => {
      expect(screen.getByText(/Higher role required/)).toBeInTheDocument();
    });
  });
});

// ── SettingsProjectPage ─────────────────────────────────────────────────────

describe("SettingsProjectPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    mockSessionRole = "owner";
    mockTeamId = "team_test";
  });

  it("renders the page header", async () => {
    mockEmptyLists();
    renderPage(SettingsProjectPage);
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("shows the Danger zone section for owner", async () => {
    mockEmptyLists();
    renderPage(SettingsProjectPage);
    await waitFor(() => {
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
    });
  });

  it("shows purge button for owner", async () => {
    mockEmptyLists();
    renderPage(SettingsProjectPage);
    await waitFor(() => {
      expect(screen.getByText(/Purge…/)).toBeInTheDocument();
    });
  });

  it("shows Staleness detection as SOON placeholder", async () => {
    mockEmptyLists();
    renderPage(SettingsProjectPage);
    await waitFor(() => {
      expect(screen.getByText("Staleness detection")).toBeInTheDocument();
    });
  });

  it("shows General settings section", async () => {
    mockEmptyLists();
    renderPage(SettingsProjectPage);
    await waitFor(() => {
      expect(screen.getByText("General")).toBeInTheDocument();
    });
  });

  it("hides purge from non-owner admin", async () => {
    mockSessionRole = "admin";
    mockEmptyLists();
    renderPage(SettingsProjectPage);
    await waitFor(() => {
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Purge…/)).toBeNull();
  });
});

// ── SettingsTeamPage ────────────────────────────────────────────────────────

describe("SettingsTeamPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    mockSessionRole = "owner";
    mockTeamId = "team_test";
  });

  it("renders the page header", async () => {
    mockEmptyLists();
    renderPage(SettingsTeamPage);
    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("shows the Danger zone for owner", async () => {
    mockEmptyLists();
    renderPage(SettingsTeamPage);
    await waitFor(() => {
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
    });
  });

  it("shows delete team button for owner", async () => {
    mockEmptyLists();
    renderPage(SettingsTeamPage);
    await waitFor(() => {
      expect(screen.getByText(/Delete team…/)).toBeInTheDocument();
    });
  });

  it("shows New team button", async () => {
    mockEmptyLists();
    renderPage(SettingsTeamPage);
    await waitFor(() => {
      expect(screen.getByText("New team")).toBeInTheDocument();
    });
  });

  it("shows multi-team hint text", async () => {
    mockEmptyLists();
    renderPage(SettingsTeamPage);
    await waitFor(() => {
      expect(
        screen.getByText(/You can belong to multiple teams/)
      ).toBeInTheDocument();
    });
  });

  it("shows empty state when no teams exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    renderPage(SettingsTeamPage);
    await waitFor(() => {
      expect(screen.getByText("No teams yet")).toBeInTheDocument();
    });
  });

  it("hides management from viewer", async () => {
    mockSessionRole = "viewer";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([{ id: "team_test", name: "Test", role: "viewer" }]) as Response
    );
    renderPage(SettingsTeamPage);
    await waitFor(() => {
      expect(screen.getByText(/Higher role required/)).toBeInTheDocument();
    });
  });
});
