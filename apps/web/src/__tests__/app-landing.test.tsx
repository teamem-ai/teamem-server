import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { useEffect } from "react";

// ── Mocks ───────────────────────────────────────────────────────────────────

let mockGetSession: Mock;

vi.mock("@/lib/api", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
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

  it("redirects to /knowledge when session exists with a team", async () => {
    mockGetSession = vi.fn().mockResolvedValue(teamSession);

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

  it("redirects to /login?noteam=1 when session exists but no team", async () => {
    mockGetSession = vi.fn().mockResolvedValue(noTeamSession);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/login?noteam=1");
    });
  });

  it("redirects to /login?noteam=1 when server says no_team and no session", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy("/app?no_team=true");
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/login?noteam=1");
    });
  });

  it("redirects to /login when no session and no invite token", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);

    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const spy = createNavigationSpy();
    render(spy.render());

    await waitFor(() => {
      expect(spy.fullPath).toBe("/login");
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
      // Falls through to normal routing
      expect(spy.fullPath).toBe("/login");
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
