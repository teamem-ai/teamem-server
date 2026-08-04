import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
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

  it("plaintext token disappears after the reveal modal is closed and list refreshes", async () => {
    const token = "tm_test_secret_token_12345";
    let minted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      const urlStr =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.endsWith("/keys") && urlStr.includes("/teams/") && init?.method === "POST") {
        minted = true;
        return Promise.resolve(
          mockFetchResponse({
            id: "key_new",
            name: "Refresh Test Key",
            token,
            mcpCommand: `claude mcp add teamem ${token}`,
            scopes: ["read"],
            allProjects: false,
            projectId: "prj_test",
            createdAt: new Date().toISOString(),
          }) as Response
        );
      }
      if (urlStr.endsWith("/keys") && urlStr.includes("/teams/")) {
        return Promise.resolve(
          mockFetchResponse(
            minted
              ? [
                  {
                    id: "key_new",
                    name: "Refresh Test Key",
                    scopes: ["read"],
                    allProjects: false,
                    projectId: "prj_test",
                    projectName: "Test Project",
                    createdAt: new Date().toISOString(),
                    lastUsedAt: null,
                    revoked: false,
                    revokedAt: null,
                  },
                ]
              : []
          ) as Response
        );
      }
      if (urlStr.includes("/projects")) {
        return Promise.resolve(
          mockFetchResponse([
            { id: "prj_test", name: "Test Project", createdAt: new Date().toISOString() },
          ]) as Response
        );
      }
      return Promise.resolve(mockFetchResponse([]) as Response);
    });
    renderPage(SettingsKeysPage);
    await waitFor(() => {
      expect(screen.getByText("Mint API key")).toBeInTheDocument();
    });
    screen.getByText("Mint API key").click();
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText('e.g. "claude-code-laptop" or "ci-readonly"') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Refresh Test Key" } });

    const projectSelect = screen.getByLabelText("Project") as HTMLSelectElement;
    fireEvent.change(projectSelect, { target: { value: "prj_test" } });

    screen.getByText("Mint key").click();

    await waitFor(() => {
      expect(screen.getByText("Key minted")).toBeInTheDocument();
      expect(screen.getByTestId("key-token")).toHaveTextContent(token);
    });

    // Close the reveal modal
    screen.getByText("Done — I've saved the key").click();

    // After the list refreshes, the plaintext token must NOT be present.
    await waitFor(() => {
      expect(screen.queryByText(token)).not.toBeInTheDocument();
    });
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

  it("mints a write key and shows the actionable CLI/MCP command", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.endsWith("/keys") && typeof url === "string" && url.includes("/teams/")) {
        return Promise.resolve(
          mockFetchResponse({
            id: "key_new",
            name: "CLI / MCP setup",
            token: "tm_test_token_123",
            mcpCommand: "claude mcp add --transport http teamem http://localhost:8080/mcp --header 'Authorization: Bearer tm_test_token_123'",
            scopes: ["events:write"],
            allProjects: false,
            projectId: "prj_test",
            createdAt: new Date().toISOString(),
          }) as Response
        );
      }
      if (urlStr.includes("/projects")) return Promise.resolve(mockFetchResponse([]) as Response);
      if (urlStr.includes("/connectors")) {
        return Promise.resolve(
          mockFetchResponse({
            github: { connected: false, appName: null, installedOn: null, repositories: [], webhookSecretConfigured: false, recentDeliveries: [] },
            cli: { lastInit: { at: null, repo: null, commitSha: null, eventsCount: 0, pagesCount: 0 }, activeKeysWithWrite: 0 },
            mcp: { endpointHealthy: true, activeKeysWithWrite: 0 },
          }) as Response
        );
      }
      if (urlStr.includes("/teams/mine")) {
        return Promise.resolve(mockFetchResponse([{ id: "team_test", name: "Test Team", role: mockSessionRole }]) as Response);
      }
      return Promise.resolve(mockFetchResponse([]) as Response);
    });
    renderPage(SettingsSourcesPage);
    await waitFor(() => {
      expect(screen.getByText("Create write key & copy command")).toBeInTheDocument();
    });
    screen.getByText("Create write key & copy command").click();
    await waitFor(() => {
      expect(screen.getByText("tm_test_token_123")).toBeInTheDocument();
      expect(screen.getByText(/teamem init.*tm_test_token_123/)).toBeInTheDocument();
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

  it("reflects the saved model and loads provider models into the dropdown", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (urlStr.includes("/llm/models")) {
          return Promise.resolve(
            mockFetchResponse({ models: ["gpt-4o", "gpt-4o-mini"] }) as Response,
          );
        }
        if (urlStr.includes("/llm")) {
          return Promise.resolve(
            mockFetchResponse({
              provider: "openai",
              model: "gpt-4o",
              hasKey: true,
              lastTest: null,
              semanticRetrieval: { available: true, mode: "vector", reason: null },
            }) as Response,
          );
        }
        return Promise.resolve(mockFetchResponse([]) as Response);
      },
    );

    renderPage(SettingsLlmPage);

    // The saved model is shown in the combobox input.
    await waitFor(() => {
      const input = screen.getByLabelText("Model") as HTMLInputElement;
      expect(input.value).toBe("gpt-4o");
    });

    // Focusing opens the typeahead; the auto-loaded models appear as options
    // (the current exact match shows the full list so you can pick another).
    fireEvent.focus(screen.getByLabelText("Model"));
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "gpt-4o-mini" }),
      ).toBeInTheDocument();
    });
  });

  it("filters models as you type in the model combobox", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (urlStr.includes("/llm/models")) {
          return Promise.resolve(
            mockFetchResponse({
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            }) as Response,
          );
        }
        if (urlStr.includes("/llm")) {
          return Promise.resolve(
            mockFetchResponse({
              provider: "openai",
              model: null,
              hasKey: true,
              lastTest: null,
              semanticRetrieval: { available: true, mode: "vector", reason: null },
            }) as Response,
          );
        }
        return Promise.resolve(mockFetchResponse([]) as Response);
      },
    );

    renderPage(SettingsLlmPage);

    const input = await screen.findByLabelText("Model");
    // Wait for models to auto-load.
    await waitFor(() => {
      fireEvent.focus(input);
      expect(screen.getByRole("option", { name: "o1-preview" })).toBeInTheDocument();
    });

    // Typing "mini" filters to just the matching model.
    fireEvent.change(input, { target: { value: "mini" } });
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "gpt-4o-mini" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("option", { name: "o1-preview" })).toBeNull();
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

  it("disables purge confirm until the correct project name is typed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url: string | URL | Request) => {
      const urlStr =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("/projects")) {
        return Promise.resolve(
          mockFetchResponse([
            { id: "prj_test", name: "Test Project", createdAt: new Date().toISOString() },
          ]) as Response
        );
      }
      if (urlStr.includes("/connectors")) {
        return Promise.resolve(
          mockFetchResponse({
            github: { connected: false, appName: null, installedOn: null, repositories: [], webhookSecretConfigured: false, recentDeliveries: [] },
            cli: { lastInit: { at: null, repo: null, commitSha: null, eventsCount: 0, pagesCount: 0 }, activeKeysWithWrite: 0 },
            mcp: { endpointHealthy: true, activeKeysWithWrite: 0 },
          }) as Response
        );
      }
      return Promise.resolve(mockFetchResponse([]) as Response);
    });
    renderPage(SettingsProjectPage);
    await waitFor(() => {
      expect(screen.getByText(/Purge…/)).toBeInTheDocument();
    });
    screen.getByText(/Purge…/).click();
    await waitFor(() => {
      expect(screen.getByText("Purge project data?")).toBeInTheDocument();
    });
    const confirm = screen.getByRole("button", { name: "Purge project data" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const input = screen.getByPlaceholderText("Test Project") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Wrong name" } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Test Project" } });
    expect(confirm.disabled).toBe(false);
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

  it("does NOT offer creating additional teams (single-team portal)", async () => {
    mockEmptyLists();
    renderPage(SettingsTeamPage);
    // Wait for the team card to render, then assert no create affordance.
    await waitFor(() => {
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
    });
    expect(screen.queryByText("New team")).toBeNull();
    expect(screen.queryByText("Create team")).toBeNull();
    expect(screen.queryByText(/belong to multiple teams/)).toBeNull();
    expect(screen.queryByText(/Switch teams from the top bar/)).toBeNull();
  });

  it("states the portal uses a single team", async () => {
    mockEmptyLists();
    renderPage(SettingsTeamPage);
    await waitFor(() => {
      expect(
        screen.getByText(/This portal uses a single team/)
      ).toBeInTheDocument();
    });
  });

  it("shows empty state (without a create-team action) when no team exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    renderPage(SettingsTeamPage);
    await waitFor(() => {
      expect(screen.getByText("No team yet")).toBeInTheDocument();
    });
    expect(screen.queryByText("Create team")).toBeNull();
    expect(screen.queryByText("New team")).toBeNull();
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
