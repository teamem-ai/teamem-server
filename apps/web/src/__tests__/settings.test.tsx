import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SettingsLayout } from "@/pages/settings-layout";
import { SettingsKeysPage } from "@/pages/settings-keys-page";
import { SettingsLlmPage } from "@/pages/settings-llm-page";
import { SettingsProjectPage } from "@/pages/settings-project-page";
import { SettingsTeamPage } from "@/pages/settings-team-page";

// ── Mock helpers ────────────────────────────────────────────────────────────

function mockFetchResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ requestId: "test", data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  it("renders the page header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsKeysPage />
      </MemoryRouter>
    );
    expect(screen.getByText("API keys")).toBeInTheDocument();
    expect(
      screen.getByText(/Keys carry data-plane scopes/)
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("No keys minted yet")).toBeInTheDocument();
    });
  });

  it("shows the Mint button for admin+", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsKeysPage />
      </MemoryRouter>
    );
    expect(screen.getByText("Mint API key")).toBeInTheDocument();
  });

  it("shows empty state when no keys are present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsKeysPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("No keys minted yet")).toBeInTheDocument();
    });
  });

  it("shows the key safety notice at the bottom", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsKeysPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(
        screen.getByText(/Key IDs.*are identifiers, safe to display/)
      ).toBeInTheDocument();
    });
  });

  it("has the Mint API key button present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsKeysPage />
      </MemoryRouter>
    );
    const btn = screen.getByText("Mint API key");
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });
});

// ── SettingsLlmPage ─────────────────────────────────────────────────────────

describe("SettingsLlmPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the page header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse({
        provider: null,
        hasKey: false,
        lastTest: null,
        semanticRetrieval: { available: false, mode: "fts-only", reason: null },
      }) as Response
    );
    render(
      <MemoryRouter>
        <SettingsLlmPage />
      </MemoryRouter>
    );
    expect(screen.getByText("LLM & retrieval")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("LLM provider")).toBeInTheDocument();
    });
  });

  it("shows semantic retrieval status section", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse({
        provider: null,
        hasKey: false,
        lastTest: null,
        semanticRetrieval: { available: false, mode: "fts-only", reason: null },
      }) as Response
    );
    render(
      <MemoryRouter>
        <SettingsLlmPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("Semantic retrieval")).toBeInTheDocument();
    });
  });

  it("shows compilation section as placeholder", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse({
        provider: null,
        hasKey: false,
        lastTest: null,
        semanticRetrieval: { available: false, mode: "fts-only", reason: null },
      }) as Response
    );
    render(
      <MemoryRouter>
        <SettingsLlmPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("Compilation")).toBeInTheDocument();
    });
  });

  it("shows fts-only mode when no embedding is available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse({
        provider: null,
        hasKey: false,
        lastTest: null,
        semanticRetrieval: { available: false, mode: "fts-only", reason: null },
      }) as Response
    );
    render(
      <MemoryRouter>
        <SettingsLlmPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText(/Unavailable — keyword/)).toBeInTheDocument();
    });
  });
});

// ── SettingsProjectPage ─────────────────────────────────────────────────────

describe("SettingsProjectPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the page header", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsProjectPage />
      </MemoryRouter>
    );
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("shows the Danger zone section for owner", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsProjectPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
    });
  });

  it("shows purge button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsProjectPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText(/Purge…/)).toBeInTheDocument();
    });
  });

  it("shows Staleness detection as SOON placeholder", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsProjectPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("Staleness detection")).toBeInTheDocument();
    });
  });

  it("shows General settings section", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsProjectPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("General")).toBeInTheDocument();
    });
  });
});

// ── SettingsTeamPage ────────────────────────────────────────────────────────

describe("SettingsTeamPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the page header", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsTeamPage />
      </MemoryRouter>
    );
    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("shows the Danger zone for owner", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([
        { id: "team_1", name: "Acme Corp", role: "owner" },
      ]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsTeamPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
    });
  });

  it("shows delete team button for owner", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([
        { id: "team_1", name: "Acme Corp", role: "owner" },
      ]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsTeamPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText(/Delete team…/)).toBeInTheDocument();
    });
  });

  it("shows New team button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([
        { id: "team_1", name: "Acme Corp", role: "owner" },
      ]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsTeamPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("New team")).toBeInTheDocument();
    });
  });

  it("shows multi-team hint text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse([
        { id: "team_1", name: "Acme Corp", role: "owner" },
      ]) as Response
    );
    render(
      <MemoryRouter>
        <SettingsTeamPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(
        screen.getByText(/You can belong to multiple teams/)
      ).toBeInTheDocument();
    });
  });
});
