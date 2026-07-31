import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// We mock the api module so we can simulate different server responses.
let mockGetSession: Mock;
let mockGetGitHubStatus: Mock;

vi.mock("@/lib/api", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getGitHubStatus: (...args: unknown[]) => mockGetGitHubStatus(...args),
}));

import { LoginPage } from "@/pages/login";

// Helper to render the login page with a given URL
function renderLogin(url: string = "/login") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <LoginPage />
    </MemoryRouter>
  );
}

describe("LoginPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── Default state (GitHub configured, not logged in) ─────────────────

  it("renders the sign-in button when GitHub is configured and user is not logged in", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });

    // The link should point to /auth/github
    const link = screen.getByText("Sign in with GitHub").closest("a");
    expect(link).toHaveAttribute("href", "/auth/github");
  });

  it("shows the tagline and feature list in default state", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/Compiled, not written/)).toBeInTheDocument();
      expect(screen.getByText(/Every claim has evidence/)).toBeInTheDocument();
      expect(screen.getByText(/Self-hosted/)).toBeInTheDocument();
    });
  });

  it("shows the footer text about team invitation", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/Access is by team invitation/)).toBeInTheDocument();
    });
  });

  // ── OAuth failure state ──────────────────────────────────────────────

  it("shows error banner on OAuth failure (error query param)", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin("/login?error=auth_failed");

    await waitFor(() => {
      // "Sign-in didn't complete." appears in both the banner title and the description
      const matches = screen.getAllByText(/Sign-in didn't complete/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    // The retry button should still be present
    expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
  });

  it("does not redirect away on OAuth failure", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin("/login?error=github_denied");

    await waitFor(() => {
      // Should show error banner, not redirect
      expect(screen.getByText(/cancelled or failed/)).toBeInTheDocument();
    });
  });

  // ── App not configured ───────────────────────────────────────────────

  it("shows disabled button when GitHub App is not configured", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: false });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin();

    await waitFor(() => {
      const button = screen.getByText("Sign in with GitHub");
      // The button should be disabled
      expect(button.closest("button")?.hasAttribute("disabled")).toBe(true);
    });
  });

  it("shows warning banner when GitHub App is not configured", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: false });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/Sign-in isn't configured yet/)).toBeInTheDocument();
      // "GitHub App" appears in both the warning banner and the footer text
      const matches = screen.getAllByText(/GitHub App/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("button is not clickable when disabled", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: false });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin();

    await waitFor(() => {
      // The button has the disabled attribute, not just a link
      const button = screen.getByText("Sign in with GitHub");
      // It should be a <button> element, not an <a>
      expect(button.closest("button")).toBeTruthy();
      expect(button.closest("a")).toBeNull();
    });
  });

  // ── No team state ────────────────────────────────────────────────────

  it("shows no-team state when session exists but no team", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue({
      userId: "user_1",
      githubLogin: "testuser",
      avatarUrl: null,
      teamId: null,
      teamName: null,
      role: null,
    });

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/You're not in a team yet/)).toBeInTheDocument();
      expect(screen.getByText(/testuser/)).toBeInTheDocument();
    });
  });

  it("shows no-team state when noteam query param is set", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue({
      userId: "user_1",
      githubLogin: "testuser",
      avatarUrl: null,
      teamId: null,
      teamName: null,
      role: null,
    });

    renderLogin("/login?noteam=1");

    await waitFor(() => {
      expect(screen.getByText(/You're not in a team yet/)).toBeInTheDocument();
    });
  });

  it("shows invite link instructions in no-team state", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue({
      userId: "user_1",
      githubLogin: "testuser",
      avatarUrl: null,
      teamId: null,
      teamName: null,
      role: null,
    });

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/invite link/)).toBeInTheDocument();
    });
  });

  it("shows sign out button in no-team state", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue({
      userId: "user_1",
      githubLogin: "testuser",
      avatarUrl: null,
      teamId: null,
      teamName: null,
      role: null,
    });

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/Sign out and switch GitHub account/)).toBeInTheDocument();
    });
  });

  // ── No fake data ─────────────────────────────────────────────────────

  it("does not contain mock or demo content", async () => {
    mockGetGitHubStatus = vi.fn().mockResolvedValue({ configured: true });
    mockGetSession = vi.fn().mockResolvedValue(null);

    renderLogin();

    await waitFor(() => {
      // These are real features, not mock data
      expect(screen.getByText(/Compiled, not written/)).toBeInTheDocument();
    });

    // Should not have any "sample" or "demo" text
    expect(screen.queryByText(/sample/i)).toBeNull();
    expect(screen.queryByText(/demo/i)).toBeNull();
  });
});
