import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { useEffect } from "react";

// ── Mocks ───────────────────────────────────────────────────────────────────

let mockGetSession: Mock;
let mockFetchProjects: Mock;

vi.mock("@/lib/api", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  fetchProjects: (...args: unknown[]) => mockFetchProjects(...args),
}));

import { AppLanding } from "@/pages/app-landing";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Renders AppLanding inside a route and captures the final navigation path. */
function createNavigationSpy(initialEntry: string = "/app") {
  let currentPath: string | null = null;
  let currentSearch: string | null = null;

  function SpyRoute() {
    const location = useLocation();
    useEffect(() => {
      currentPath = location.pathname;
      currentSearch = location.search;
    }, [location]);
    return <div data-testid="spy" />;
  }

  function render() {
    return (
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/app" element={<AppLanding />} />
          <Route path="*" element={<SpyRoute />} />
        </Routes>
      </MemoryRouter>
    );
  }

  return {
    render,
    get path() {
      return currentPath;
    },
    get search() {
      return currentSearch;
    },
    get fullPath() {
      return currentPath !== null
        ? `${currentPath}${currentSearch}`
        : null;
    },
  };
}

const noTeamSession = {
  userId: "user_1",
  githubLogin: "dli",
  avatarUrl: null,
  teamId: null,
  teamName: null,
  role: null,
};

const teamSession = {
  ...noTeamSession,
  teamId: "team_1",
  teamName: "Test Team",
  role: "member",
};

describe("AppLanding", () => {
  beforeEach(() => {
    // Default: a team with one project (fully onboarded). Individual tests
    // override to [] to exercise the "no project yet → onboarding" branch.
    mockFetchProjects = vi.fn().mockResolvedValue([
      { id: "prj_1", teamId: "team_1", name: "web", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── Invite token recovery ──────────────────────────────────────────────

  it("recovers invite token from sessionStorage and redirects to /join", async () => {
    mockGetSession = vi.fn().mockResolvedValue(noTeamSession);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn((key: string) =>
        key === "teamem_invite_token" ? "inv_recovered123" : null,
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/join?token=inv_recovered123");
    });
  });

  it("clears the stored invite token after recovery", async () => {
    mockGetSession = vi.fn().mockResolvedValue(noTeamSession);

    const removeItemSpy = vi.fn();
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => "inv_cleaned"),
      setItem: vi.fn(),
      removeItem: removeItemSpy,
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/join?token=inv_cleaned");
    });

    expect(removeItemSpy).toHaveBeenCalledWith("teamem_invite_token");
  });

  it("does NOT check session when invite token is found", async () => {
    mockGetSession = vi.fn().mockResolvedValue(noTeamSession);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => "inv_noapi"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/join?token=inv_noapi");
    });

    // getSession should NOT be called — the invite token takes priority
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  // ── Normal routing (no invite token) ───────────────────────────────────

  it("redirects to /knowledge when session has a team with a project", async () => {
    mockGetSession = vi.fn().mockResolvedValue(teamSession);
    mockFetchProjects = vi.fn().mockResolvedValue([
      { id: "prj_1", teamId: "team_1", name: "web", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/knowledge");
    });
  });

  it("redirects to /onboarding when session has a team but no project yet", async () => {
    mockGetSession = vi.fn().mockResolvedValue(teamSession);
    mockFetchProjects = vi.fn().mockResolvedValue([]);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/onboarding");
    });
  });

  it("redirects to /onboarding when session exists but no team", async () => {
    mockGetSession = vi.fn().mockResolvedValue(noTeamSession);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/onboarding");
    });
  });

  it("redirects to /onboarding when no session (its sign-in step handles it)", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/onboarding");
    });
  });

  // ── SessionStorage safety ──────────────────────────────────────────────

  it("handles sessionStorage being unavailable gracefully", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);

    // Simulate sessionStorage throwing (e.g., private browsing)
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      // Falls through to normal routing (no session → onboarding front door)
      expect(spy.fullPath).toBe("/onboarding");
    });
  });

  it("encodes the invite token properly in the redirect URL", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => "inv_token_with_special+chars"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe(
        "/join?token=inv_token_with_special%2Bchars",
      );
    });
  });
});
