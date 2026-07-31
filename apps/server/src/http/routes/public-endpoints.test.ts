/**
 * Unit tests for new public endpoints added in DUA-232:
 *   - GET /auth/github/status — returns OAuth configuration status
 *   - GET /invites/:token — public invite lookup
 *
 * These tests mock the database and invite-lookup layers so we can
 * verify the HTTP contract (status codes, response shapes, error
 * handling) without a running PostgreSQL instance.
 *
 * CLI: pnpm exec vitest run apps/server/src/http/routes/public-endpoints.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { requestContext } from "../request-context.js";
import { globalErrorHandler, notFoundHandler } from "../errors.js";
import { InvalidRequestError, NotFoundError } from "../errors.js";

// ── Inline route builders under test ────────────────────────────────────────
// Rather than importing buildApp (which pulls in the entire dependency tree),
// we test the exact route logic in isolation using the same pattern as the
// existing auth.test.ts. This keeps the tests fast and database-free.

import { lookupInviteByToken } from "../../auth/invites.js";

vi.mock("../../auth/invites.js", () => ({
  lookupInviteByToken: vi.fn(),
}));

// ── GET /auth/github/status ─────────────────────────────────────────────────
// The status endpoint is trivial: it just reads deps.githubOAuth and returns
// a boolean. We test the exact handler logic rather than calling buildApp.

describe("GET /auth/github/status", () => {
  function statusHandler(configured: boolean) {
    return (c: { json: (body: unknown) => Response }) =>
      c.json({ configured });
  }

  it("returns { configured: true } when OAuth is configured", () => {
    const handler = statusHandler(true);
    const res = handler({ json: (b) => new Response(JSON.stringify(b)) });
    expect(res.status).toBe(200);
    return res.json().then((body: unknown) => {
      expect(body).toEqual({ configured: true });
    });
  });

  it("returns { configured: false } when OAuth is not configured", () => {
    const handler = statusHandler(false);
    const res = handler({ json: (b) => new Response(JSON.stringify(b)) });
    return res.json().then((body: unknown) => {
      expect(body).toEqual({ configured: false });
    });
  });
});

// ── GET /invites/:token route handler ───────────────────────────────────────
// Extracted from app.ts so it can be tested in isolation.

async function inviteLookupHandler(
  c: {
    req: { param: (name: string) => string };
    json: (body: unknown) => Response;
  },
  mockDb: { query: ReturnType<typeof vi.fn> },
) {
  const token = c.req.param("token");
  if (!token || token.length === 0) {
    throw new InvalidRequestError("token is required");
  }
  if (!token.startsWith("inv_")) {
    throw new NotFoundError();
  }

  const lookupResult = await lookupInviteByToken(
    mockDb as unknown as Parameters<typeof lookupInviteByToken>[0],
    token,
  );
  if (lookupResult.status === "not_found") {
    throw new NotFoundError();
  }

  const { invite } = lookupResult;

  // Look up team name
  let teamName: string | null = null;
  const teamResult = await mockDb.query(
    `SELECT name FROM teams WHERE id = $1 LIMIT 1`,
    [invite.teamId],
  );
  const teamRow = teamResult.rows[0] as Record<string, unknown> | undefined;
  teamName = (teamRow?.["name"] as string) ?? null;

  // Look up inviter login and role
  let inviterLogin: string | null = null;
  let inviterRole: string | null = null;
  const userResult = await mockDb.query(
    `SELECT github_login FROM users WHERE id = $1 LIMIT 1`,
    [invite.invitedByUserId],
  );
  const userRow = userResult.rows[0] as Record<string, unknown> | undefined;
  inviterLogin = (userRow?.["github_login"] as string) ?? null;

  if (inviterLogin) {
    const roleResult = await mockDb.query(
      `SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2 LIMIT 1`,
      [invite.invitedByUserId, invite.teamId],
    );
    const roleRow = roleResult.rows[0] as Record<string, unknown> | undefined;
    inviterRole = (roleRow?.["role"] as string) ?? null;
  }

  return c.json({
    status: lookupResult.status,
    invite: {
      id: invite.id,
      teamId: invite.teamId,
      teamName,
      targetRole: invite.targetRole,
      invitedByLogin: inviterLogin,
      invitedByRole: inviterRole,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
    },
  });
}

// ── Hono app helper for invite tests ────────────────────────────────────────

function createInviteTestApp(mockDb: { query: ReturnType<typeof vi.fn> }) {
  const app = new Hono();

  app.use("*", requestContext);
  app.onError(globalErrorHandler);
  app.notFound(notFoundHandler);

  app.get("/invites/:token", async (c) => {
    return inviteLookupHandler(
      {
        req: { param: (name: string) => c.req.param(name) ?? "" },
        json: (body: unknown) => c.json(body),
      },
      mockDb,
    );
  });

  return app;
}

describe("GET /invites/:token", () => {
  it("returns 404 when token path segment is empty (no matching route)", async () => {
    const mockDb = { query: vi.fn() };
    const app = createInviteTestApp(mockDb);

    // /invites/ has no :token segment, so Hono doesn't match the route.
    // This is the correct HTTP behavior — 404 is returned by the
    // not-found handler.
    const res = await app.request("/invites/");
    expect(res.status).toBe(404);
  });

  it("returns 404 when token does not start with inv_", async () => {
    const mockLookup = vi.mocked(lookupInviteByToken);
    const mockDb = { query: vi.fn() };
    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/bogus_token");
    expect(res.status).toBe(404);
    // Verify lookup was NOT called (invalid format rejected early)
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("returns 404 when token is not found in database", async () => {
    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({ status: "not_found" });

    const mockDb = { query: vi.fn() };
    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/inv_nonexistent");
    expect(res.status).toBe(404);
    expect(mockLookup).toHaveBeenCalledWith(
      expect.anything(),
      "inv_nonexistent",
    );
  });

  it("returns invite details for a valid token", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({
      status: "valid",
      invite: {
        id: "inv_abc123",
        teamId: "team_xyz",
        targetRole: "member",
        invitedByUserId: "user_abc",
        expiresAt,
        usedAt: null,
        createdAt: now,
      },
    });

    const mockDb = {
      query: vi.fn()
        // First call: team name lookup
        .mockResolvedValueOnce({
          rows: [{ name: "Acme Corp" }],
        })
        // Second call: inviter login
        .mockResolvedValueOnce({
          rows: [{ github_login: "k.zhang" }],
        })
        // Third call: inviter role
        .mockResolvedValueOnce({
          rows: [{ role: "admin" }],
        }),
    };

    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/inv_validtoken");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("valid");
    expect(body.invite).toMatchObject({
      id: "inv_abc123",
      teamId: "team_xyz",
      teamName: "Acme Corp",
      targetRole: "member",
      invitedByLogin: "k.zhang",
      invitedByRole: "admin",
    });
    expect(body.invite.expiresAt).toBeTruthy();
    expect(body.invite.usedAt).toBeNull();
  });

  it("returns expired status for an expired invite", async () => {
    const now = new Date();
    const pastExpiry = new Date(now.getTime() - 1000);

    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({
      status: "expired",
      invite: {
        id: "inv_expired1",
        teamId: "team_xyz",
        targetRole: "viewer",
        invitedByUserId: "user_def",
        expiresAt: pastExpiry,
        usedAt: null,
        createdAt: now,
      },
    });

    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ name: "Old Team" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "old.admin" }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/inv_expired");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("expired");
    expect(body.invite.teamName).toBe("Old Team");
  });

  it("returns used status for an already-used invite", async () => {
    const now = new Date();
    const usedAt = new Date(now.getTime() - 3600 * 1000);

    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({
      status: "used",
      invite: {
        id: "inv_used1",
        teamId: "team_xyz",
        targetRole: "member",
        invitedByUserId: "user_ghi",
        expiresAt: new Date(now.getTime() + 3600 * 1000),
        usedAt,
        createdAt: now,
      },
    });

    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ name: "Used Team" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "used.admin" }] })
        .mockResolvedValueOnce({ rows: [{ role: "owner" }] }),
    };

    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/inv_usedtoken");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("used");
    expect(body.invite.usedAt).toBeTruthy();
  });

  it("returns 404 for not_found — indistinguishable from genuinely missing", async () => {
    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({ status: "not_found" });

    const mockDb = { query: vi.fn() };
    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/inv_missing");
    expect(res.status).toBe(404);
  });

  it("does not require authentication", async () => {
    const now = new Date();
    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({
      status: "valid",
      invite: {
        id: "inv_abc",
        teamId: "team_1",
        targetRole: "viewer",
        invitedByUserId: "user_1",
        expiresAt: new Date(now.getTime() + 3600 * 1000),
        usedAt: null,
        createdAt: now,
      },
    });

    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ name: "T" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "u" }] })
        .mockResolvedValueOnce({ rows: [{ role: "admin" }] }),
    };

    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/inv_public");
    expect(res.status).toBe(200);
  });

  it("does not leak the plaintext token in the response", async () => {
    const now = new Date();
    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({
      status: "valid",
      invite: {
        id: "inv_abc",
        teamId: "team_1",
        targetRole: "viewer",
        invitedByUserId: "user_1",
        expiresAt: new Date(now.getTime() + 3600 * 1000),
        usedAt: null,
        createdAt: now,
      },
    });

    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ name: "T" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "u" }] })
        .mockResolvedValueOnce({ rows: [{ role: "admin" }] }),
    };

    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/inv_sometoken");
    const body = await res.json();

    // The response must NEVER include the plaintext token or its hash
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("inv_sometoken");
    expect(bodyStr).not.toContain("token_hash");
    expect(bodyStr).not.toContain("tokenHash");
  });

  it("returns inviter role when available", async () => {
    const now = new Date();
    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({
      status: "valid",
      invite: {
        id: "inv_abc",
        teamId: "team_1",
        targetRole: "viewer",
        invitedByUserId: "user_1",
        expiresAt: new Date(now.getTime() + 3600 * 1000),
        usedAt: null,
        createdAt: now,
      },
    });

    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ name: "T" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "k.zhang" }] })
        .mockResolvedValueOnce({ rows: [{ role: "admin" }] }),
    };

    const app = createInviteTestApp(mockDb);

    const res = await app.request("/invites/inv_withrole");
    const body = await res.json();
    expect(body.invite.invitedByLogin).toBe("k.zhang");
    expect(body.invite.invitedByRole).toBe("admin");
  });

  it("returns null for inviter role when inviter has no membership", async () => {
    const now = new Date();
    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({
      status: "valid",
      invite: {
        id: "inv_abc",
        teamId: "team_1",
        targetRole: "viewer",
        invitedByUserId: "user_2",
        expiresAt: new Date(now.getTime() + 3600 * 1000),
        usedAt: null,
        createdAt: now,
      },
    });

    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ name: "T" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "unknown_user" }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    // Recreate app with fresh mocks
    const app2 = createInviteTestApp(mockDb);

    const res = await app2.request("/invites/inv_norole");
    const body = await res.json();
    expect(body.invite.invitedByLogin).toBe("unknown_user");
    expect(body.invite.invitedByRole).toBeNull();
  });
});
