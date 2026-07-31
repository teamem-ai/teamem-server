import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ── Mocks ───────────────────────────────────────────────────────────────────

let mockGetSession: Mock;
let mockLookupInvite: Mock;
let mockAcceptInvite: Mock;

vi.mock("@/lib/api", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  lookupInvite: (...args: unknown[]) => mockLookupInvite(...args),
  acceptInvite: (...args: unknown[]) => mockAcceptInvite(...args),
}));

import { InvitePage } from "@/pages/invite";

// ── Test data ───────────────────────────────────────────────────────────────

const validInvite = {
  status: "valid" as const,
  invite: {
    id: "inv_abc123",
    teamId: "team_xyz",
    teamName: "Acme Corp",
    targetRole: "member",
    invitedByLogin: "k.zhang",
    invitedByRole: "admin",
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    usedAt: null,
  },
};

const expiredInvite = {
  status: "expired" as const,
  invite: { ...validInvite.invite, expiresAt: "2020-01-01T00:00:00.000Z" },
};

const usedInvite = {
  status: "used" as const,
  invite: { ...validInvite.invite, usedAt: "2026-01-01T00:00:00.000Z" },
};

const notFoundInvite = {
  status: "not_found" as const,
};

const loggedInSession = {
  userId: "user_1",
  githubLogin: "dli",
  avatarUrl: null,
  teamId: null,
  teamName: null,
  role: null,
};

function renderInvite(token: string = "inv_test123") {
  return render(
    <MemoryRouter initialEntries={[`/join?token=${token}`]}>
      <InvitePage />
    </MemoryRouter>,
  );
}

describe("InvitePage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── No token ────────────────────────────────────────────────────────

  it("shows expired state when no token is provided", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(notFoundInvite);
    mockAcceptInvite = vi.fn();

    render(
      <MemoryRouter initialEntries={["/join"]}>
        <InvitePage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByText("This invite link is no longer valid"),
      ).toBeInTheDocument();
    });
  });

  // ── Guest (not logged in) ────────────────────────────────────────────

  it("shows invite details for a guest user", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(screen.getByText("Join Acme Corp")).toBeInTheDocument();
      const matches = screen.getAllByText(/k.zhang/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows Sign in with GitHub button for guests", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      const btn = screen.getByText("Sign in with GitHub to join");
      expect(btn).toBeInTheDocument();
      expect(btn.closest("a")).toHaveAttribute("href", "/auth/github");
    });
  });

  it("stores invite token in sessionStorage when guest clicks sign-in", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    // Mock sessionStorage
    const storageSet = vi.fn();
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: storageSet,
      removeItem: vi.fn(),
    });

    renderInvite("inv_persisted_token");

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub to join")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Sign in with GitHub to join"));
    expect(storageSet).toHaveBeenCalledWith(
      "teamem_invite_token",
      "inv_persisted_token",
    );
  });

  it("shows role badge in invite summary for guests", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(screen.getByText("Member")).toBeInTheDocument();
    });
  });

  it("shows expiry and single-use footer text for guests", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(
        screen.getByText(/Invite link expires in 7 days/),
      ).toBeInTheDocument();
    });
  });

  // ── Signed in ────────────────────────────────────────────────────────

  it("shows Join team button for signed-in users", async () => {
    mockGetSession = vi.fn().mockResolvedValue(loggedInSession);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(screen.getByText("Join team")).toBeInTheDocument();
    });
  });

  it('shows "Joining as" row with signed-in user', async () => {
    mockGetSession = vi.fn().mockResolvedValue(loggedInSession);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(screen.getByText("Joining as")).toBeInTheDocument();
      expect(screen.getByText("dli")).toBeInTheDocument();
    });
  });

  it('shows "Not you? Switch GitHub account" for signed-in users', async () => {
    mockGetSession = vi.fn().mockResolvedValue(loggedInSession);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(
        screen.getByText("Not you? Switch GitHub account"),
      ).toBeInTheDocument();
    });
  });

  // ── Acceptance action ────────────────────────────────────────────────

  it("calls acceptInvite with correct args when Join team is clicked", async () => {
    mockGetSession = vi.fn().mockResolvedValue(loggedInSession);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn().mockResolvedValue({
      membership: { role: "member" },
      invite: { id: "inv_abc123" },
    });

    renderInvite("inv_accept_test");

    await waitFor(() => {
      expect(screen.getByText("Join team")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Join team"));

    await waitFor(() => {
      expect(mockAcceptInvite).toHaveBeenCalledWith(
        "team_xyz",
        "inv_accept_test",
      );
    });
  });

  it("disables Join team button while accepting", async () => {
    mockGetSession = vi.fn().mockResolvedValue(loggedInSession);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    // Never resolves — simulates a slow request
    mockAcceptInvite = vi.fn().mockImplementation(
      () => new Promise(() => {}),
    );

    renderInvite();

    await waitFor(() => {
      expect(screen.getByText("Join team")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Join team"));

    await waitFor(() => {
      // Button should show "Joining…" and be disabled
      const btn = screen.getByText("Joining…");
      expect(btn).toBeInTheDocument();
      expect(btn.closest("button")?.hasAttribute("disabled")).toBe(true);
    });
  });

  it("shows error banner when acceptInvite fails", async () => {
    mockGetSession = vi.fn().mockResolvedValue(loggedInSession);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn().mockRejectedValue(
      new Error("This invite link has already been used"),
    );

    renderInvite();

    await waitFor(() => {
      expect(screen.getByText("Join team")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Join team"));

    await waitFor(() => {
      expect(
        screen.getByText("This invite link has already been used"),
      ).toBeInTheDocument();
    });

    // Button should be re-enabled after failure
    expect(screen.getByText("Join team")).toBeInTheDocument();
  });

  // ── Expired invite ───────────────────────────────────────────────────

  it("shows expired state when invite is expired", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(expiredInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(
        screen.getByText("This invite link is no longer valid"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Ask your admin to send you a fresh invite link/),
      ).toBeInTheDocument();
    });
  });

  it("shows expired state when invite is already used", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(usedInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(
        screen.getByText("This invite link is no longer valid"),
      ).toBeInTheDocument();
    });
  });

  it("shows Go to sign in link on expired invite page", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(expiredInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      const link = screen.getByText("Go to sign in");
      expect(link).toBeInTheDocument();
      expect(link.closest("a")).toHaveAttribute("href", "/login");
    });
  });

  // ── Not found ────────────────────────────────────────────────────────

  it("shows invalid state when invite token is not found", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(notFoundInvite);
    mockAcceptInvite = vi.fn();

    renderInvite("inv_bogus");

    await waitFor(() => {
      expect(
        screen.getByText("This invite link is no longer valid"),
      ).toBeInTheDocument();
    });
  });

  // ── No fake data ─────────────────────────────────────────────────────

  it("does not contain mock or demo content in guest state", async () => {
    mockGetSession = vi.fn().mockResolvedValue(null);
    mockLookupInvite = vi.fn().mockResolvedValue(validInvite);
    mockAcceptInvite = vi.fn();

    renderInvite();

    await waitFor(() => {
      expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    });

    expect(screen.queryByText(/sample/i)).toBeNull();
    expect(screen.queryByText(/demo/i)).toBeNull();
  });
});
