import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { MembersPage } from "@/pages/members-page";
import { MemberProfilePage } from "@/pages/member-profile-page";

// ── Mock fetch globally ────────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderProfilePage(userId: string) {
  return render(
    <MemoryRouter initialEntries={[`/members/${userId}`]}>
      <Routes>
        <Route path="/members/:userId" element={<MemberProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setupMembersMocks(members: unknown[], currentUser: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ data: members }),
  });
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => currentUser,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MembersPage
// ═══════════════════════════════════════════════════════════════════════════════

describe("MembersPage", () => {
  it("renders loading skeleton initially", () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Member")).toBeInTheDocument();
    expect(screen.getByText("Role")).toBeInTheDocument();
    expect(screen.getByText("Joined")).toBeInTheDocument();
  });

  it("renders empty state when only the current user exists", async () => {
    setupMembersMocks(
      [
        {
          userId: "usr_a",
          githubLogin: "onlyuser",
          avatarUrl: null,
          role: "owner",
          joinedAt: "2026-07-28T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
      ],
      {
        userId: "usr_a",
        githubLogin: "onlyuser",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "owner",
      },
    );

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("It's just you so far")).toBeInTheDocument();
    });

    expect(screen.getByText(/Invite your first teammate/)).toBeInTheDocument();
  });

  it("renders member list with You badge for current user", async () => {
    setupMembersMocks(
      [
        {
          userId: "usr_a",
          githubLogin: "owneruser",
          avatarUrl: null,
          role: "owner",
          joinedAt: "2026-07-28T00:00:00.000Z",
          principalId: "pri_1",
          principalDisplayLogin: "owneruser",
        },
        {
          userId: "usr_b",
          githubLogin: "memberuser",
          avatarUrl: null,
          role: "member",
          joinedAt: "2026-07-29T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
      ],
      {
        userId: "usr_a",
        githubLogin: "owneruser",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "owner",
      },
    );

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("owneruser")).toBeInTheDocument();
    });

    expect(screen.getByText("memberuser")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    // "Member" appears both as table header and role badge
    expect(screen.getAllByText("Member").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("shows role dropdown for owner viewing other members", async () => {
    setupMembersMocks(
      [
        {
          userId: "usr_owner",
          githubLogin: "owneruser",
          avatarUrl: null,
          role: "owner",
          joinedAt: "2026-07-28T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
        {
          userId: "usr_member",
          githubLogin: "memberuser",
          avatarUrl: null,
          role: "member",
          joinedAt: "2026-07-29T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
      ],
      {
        userId: "usr_owner",
        githubLogin: "owneruser",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "owner",
      },
    );

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("memberuser")).toBeInTheDocument();
    });

    const roleChips = document.querySelectorAll(".role-dropdown-chip");
    expect(roleChips.length).toBeGreaterThan(0);
  });

  it("hides role dropdown and remove from non-owner view", async () => {
    setupMembersMocks(
      [
        {
          userId: "usr_owner",
          githubLogin: "owneruser",
          avatarUrl: null,
          role: "owner",
          joinedAt: "2026-07-28T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
        {
          userId: "usr_viewer",
          githubLogin: "vieweruser",
          avatarUrl: null,
          role: "viewer",
          joinedAt: "2026-07-29T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
      ],
      {
        userId: "usr_viewer",
        githubLogin: "vieweruser",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "viewer",
      },
    );

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("owneruser")).toBeInTheDocument();
    });

    expect(screen.queryByText("Remove")).toBeNull();
    expect(document.querySelectorAll(".role-dropdown-chip").length).toBe(0);
  });

  it("shows error state when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Failed to load members")).toBeInTheDocument();
    });
  });

  it("invite button opens modal", async () => {
    setupMembersMocks(
      [
        {
          userId: "usr_a",
          githubLogin: "adminuser",
          avatarUrl: null,
          role: "admin",
          joinedAt: "2026-07-28T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
        {
          userId: "usr_b",
          githubLogin: "memberuser",
          avatarUrl: null,
          role: "member",
          joinedAt: "2026-07-29T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
      ],
      {
        userId: "usr_a",
        githubLogin: "adminuser",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "admin",
      },
    );

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("memberuser")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Invite member"));

    await waitFor(() => {
      expect(screen.getByText("Create invite link")).toBeInTheDocument();
    });

    expect(screen.getByText("Viewer")).toBeInTheDocument();
    // "Member" appears as table header, role badge, and modal option
    expect(screen.getAllByText("Member").length).toBeGreaterThanOrEqual(2);
    // "Admin" appears in modal + table (current user is admin)
    expect(screen.getAllByText("Admin").length).toBeGreaterThanOrEqual(1);
    // "Owner" is NOT shown — current user is admin, not owner
    // (admin cannot invite as owner per server-side RBAC)
    expect(screen.queryByText("Owner")).toBeNull();
  });

  it("invite modal generates link", async () => {
    setupMembersMocks(
      [
        {
          userId: "usr_a",
          githubLogin: "adminuser",
          avatarUrl: null,
          role: "admin",
          joinedAt: "2026-07-28T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
        {
          userId: "usr_b",
          githubLogin: "memberuser",
          avatarUrl: null,
          role: "member",
          joinedAt: "2026-07-29T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
      ],
      {
        userId: "usr_a",
        githubLogin: "adminuser",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "admin",
      },
    );

    // Third call: POST /teams/team_1/invites
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        id: "inv_abc",
        inviteLink: "http://localhost:8080/join?token=inv_test123",
        targetRole: "member",
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      }),
    });

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("memberuser")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Invite member"));

    await waitFor(() => {
      expect(screen.getByText("Create invite link")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Create invite link"));

    await waitFor(() => {
      expect(screen.getByText("Invite link ready")).toBeInTheDocument();
    });

    expect(screen.getByText(/7 days/)).toBeInTheDocument();
    expect(screen.getByText(/single use/)).toBeInTheDocument();
  });

  it("owner can remove other members", async () => {
    setupMembersMocks(
      [
        {
          userId: "usr_owner",
          githubLogin: "owneruser",
          avatarUrl: null,
          role: "owner",
          joinedAt: "2026-07-28T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
        {
          userId: "usr_m",
          githubLogin: "memberuser",
          avatarUrl: null,
          role: "member",
          joinedAt: "2026-07-29T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
        {
          userId: "usr_a",
          githubLogin: "adminuser",
          avatarUrl: null,
          role: "admin",
          joinedAt: "2026-07-29T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
      ],
      {
        userId: "usr_owner",
        githubLogin: "owneruser",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "owner",
      },
    );

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("memberuser")).toBeInTheDocument();
    });

    const removeButtons = screen.getAllByText("Remove");
    expect(removeButtons.length).toBe(2);
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("shows footer note about owner-only actions", async () => {
    setupMembersMocks(
      [
        {
          userId: "usr_a",
          githubLogin: "user1",
          avatarUrl: null,
          role: "owner",
          joinedAt: "2026-07-28T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
        {
          userId: "usr_b",
          githubLogin: "user2",
          avatarUrl: null,
          role: "member",
          joinedAt: "2026-07-29T00:00:00.000Z",
          principalId: null,
          principalDisplayLogin: null,
        },
      ],
      {
        userId: "usr_a",
        githubLogin: "user1",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "owner",
      },
    );

    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("user2")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Only owners can change roles or remove members/),
    ).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MemberProfilePage
// ═══════════════════════════════════════════════════════════════════════════════

describe("MemberProfilePage", () => {
  it("renders loading state initially", () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));

    renderProfilePage("usr_test");

    expect(screen.getByText("Members")).toBeInTheDocument();
  });

  it("shows 404 for non-existent member", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            userId: "usr_other",
            githubLogin: "otheruser",
            avatarUrl: null,
            role: "owner",
            joinedAt: "2026-07-28T00:00:00.000Z",
            principalId: null,
            principalDisplayLogin: null,
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        userId: "usr_other",
        githubLogin: "otheruser",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "owner",
      }),
    });

    renderProfilePage("usr_nonexistent");

    await waitFor(() => {
      expect(screen.getByText("Not found")).toBeInTheDocument();
    });
  });

  it("renders member profile with role and join date", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            userId: "usr_abc",
            githubLogin: "contributor",
            avatarUrl: null,
            role: "member",
            joinedAt: "2026-07-29T00:00:00.000Z",
            principalId: "pri_1",
            principalDisplayLogin: "contributor",
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        userId: "usr_viewer",
        githubLogin: "viewer",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "viewer",
      }),
    });
    // projects fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "prj_1" }] }),
    });
    // concepts fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [], nextCursor: null }),
    });

    renderProfilePage("usr_abc");

    await waitFor(() => {
      expect(screen.getByText("contributor")).toBeInTheDocument();
    });

    expect(screen.getByText("Member")).toBeInTheDocument();
    expect(screen.getByText(/Joined July 29, 2026/)).toBeInTheDocument();
    expect(screen.getByText("Members")).toBeInTheDocument();
    // Attribution footnote appears twice: empty state desc + dedicated footnote
    expect(
      screen.getAllByText(/Only webhook-verified contributions appear here/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("renders contributed concepts when available", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            userId: "usr_contrib",
            githubLogin: "contributor",
            avatarUrl: null,
            role: "member",
            joinedAt: "2026-07-29T00:00:00.000Z",
            principalId: "pri_1",
            principalDisplayLogin: "contributor",
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        userId: "usr_viewer",
        githubLogin: "viewer",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "viewer",
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "prj_1" }] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            uuid: "00000000-0000-0000-0000-000000000001",
            path: "decisions/use-postgres",
            type: "decision",
            status: "active",
            confidence: "high",
            title: "Use PostgreSQL as primary database",
            tags: ["postgresql", "database"],
            lastConfirmed: "2026-07-28T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    });

    renderProfilePage("usr_contrib");

    // Wait for both the profile AND the contributed concepts to load.
    // The profile renders first, then concepts load in a second async hop
    // (projectId is obtained after profile load, then concepts are fetched).
    await waitFor(() => {
      expect(screen.getByText("contributor")).toBeInTheDocument();
      expect(screen.getByText(/Contributed pages · 1/)).toBeInTheDocument();
    });

    expect(
      screen.getByText("Use PostgreSQL as primary database"),
    ).toBeInTheDocument();
  });

  it("shows empty state when member has no contributions", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            userId: "usr_new",
            githubLogin: "newuser",
            avatarUrl: null,
            role: "viewer",
            joinedAt: "2026-07-30T00:00:00.000Z",
            principalId: null,
            principalDisplayLogin: null,
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        userId: "usr_viewer",
        githubLogin: "viewer",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Test",
        role: "viewer",
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "prj_1" }] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [], nextCursor: null }),
    });

    renderProfilePage("usr_new");

    await waitFor(() => {
      expect(screen.getByText("newuser")).toBeInTheDocument();
    });

    expect(screen.getByText(/No contributions yet/)).toBeInTheDocument();
  });

  it("shows error state when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    renderProfilePage("usr_test");

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load member profile"),
      ).toBeInTheDocument();
    });
  });
});
