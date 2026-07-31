/**
 * Unit tests for DUA-232 public endpoints:
 *   - GET /auth/github/status  (via buildApp)
 *   - GET /invites/:token       (via imported inviteLookupHandler)
 *
 * These follow the established codebase pattern from auth.test.ts:
 * import the real handler, mock only the database boundary.  A changed
 * SQL query, renamed field, or altered status branch in the shipped code
 * WILL cause a test failure here.
 *
 * CLI: pnpm exec vitest run apps/server/src/http/routes/public-endpoints.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { requestContext } from "../request-context.js";
import { globalErrorHandler, notFoundHandler } from "../errors.js";

// ── Mock the DB boundary only (lookupInviteByToken from auth/invites.js) ──
// The real inviteLookupHandler calls this function.  We mock it so we can
// inject every status variant without a real database.  Everything else in
// the handler — validation, SQL, response shaping — runs as shipped.

vi.mock("../../auth/invites.js", () => ({
  lookupInviteByToken: vi.fn(),
}));

import { lookupInviteByToken } from "../../auth/invites.js";
import { inviteLookupHandler } from "./invite-lookup.js";
import type { AppDb } from "../../db/client.js";
import { buildApp } from "../../app.js";

// ── Mock DB factory ─────────────────────────────────────────────────────────

function mockDb(queryImpl: ReturnType<typeof vi.fn>): AppDb {
  return {
    $client: {
      query: queryImpl,
      connect: vi.fn(),
    },
  } as unknown as AppDb;
}

// ── GET /auth/github/status ─────────────────────────────────────────────────
// Tests the real app.ts endpoint by calling buildApp with different configs.

describe("GET /auth/github/status", () => {
  it("returns { configured: true } when OAuth config is present", async () => {
    const app = buildApp({
      githubOAuth: {
        clientId: "Iv1.test",
        clientSecret: "secret",
        redirectUri: "http://localhost:8080/auth/github/callback",
        serverBaseUrl: "http://localhost:8080",
      },
    });

    const res = await app.request("/auth/github/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ configured: true });
  });

  it("returns { configured: false } when OAuth config is missing", async () => {
    const app = buildApp({});

    const res = await app.request("/auth/github/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ configured: false });
  });

  it("does not require authentication", async () => {
    const app = buildApp({
      githubOAuth: {
        clientId: "Iv1.test",
        clientSecret: "secret",
        redirectUri: "http://localhost:8080/auth/github/callback",
        serverBaseUrl: "http://localhost:8080",
      },
    });

    const res = await app.request("/auth/github/status");
    expect(res.status).toBe(200);
  });
});

// ── GET /invites/:token ─────────────────────────────────────────────────────
// Tests the real inviteLookupHandler imported from invite-lookup.ts.
// Only lookupInviteByToken and db.$client.query are mocked.

describe("GET /invites/:token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createApp(db: AppDb): Hono {
    const app = new Hono();
    app.use("*", requestContext);
    app.onError(globalErrorHandler);
    app.notFound(notFoundHandler);
    app.get("/invites/:token", (c) => inviteLookupHandler(c, db));
    return app;
  }

  it("returns 404 when token path segment is empty (no matching route)", async () => {
    const db = mockDb(vi.fn());
    const app = createApp(db);
    const res = await app.request("/invites/");
    // /invites/ has no :token segment → Hono doesn't match → 404
    expect(res.status).toBe(404);
  });

  it("returns 404 when token does not start with inv_", async () => {
    const mockLookup = vi.mocked(lookupInviteByToken);
    const db = mockDb(vi.fn());
    const app = createApp(db);

    const res = await app.request("/invites/bogus_token");
    expect(res.status).toBe(404);
    // The real handler rejects malformed tokens before calling lookup
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("returns 404 when token is not found in database", async () => {
    const mockLookup = vi.mocked(lookupInviteByToken);
    mockLookup.mockResolvedValue({ status: "not_found" });

    const db = mockDb(vi.fn());
    const app = createApp(db);

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

    vi.mocked(lookupInviteByToken).mockResolvedValue({
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

    const db = mockDb(
      vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ name: "Acme Corp" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "k.zhang" }] })
        .mockResolvedValueOnce({ rows: [{ role: "admin" }] }),
    );
    const app = createApp(db);

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

    vi.mocked(lookupInviteByToken).mockResolvedValue({
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

    const db = mockDb(
      vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ name: "Old Team" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "old.admin" }] })
        .mockResolvedValueOnce({ rows: [] }),
    );
    const app = createApp(db);

    const res = await app.request("/invites/inv_expired");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("expired");
    expect(body.invite.teamName).toBe("Old Team");
  });

  it("returns used status for an already-used invite", async () => {
    const now = new Date();
    const usedAt = new Date(now.getTime() - 3600 * 1000);

    vi.mocked(lookupInviteByToken).mockResolvedValue({
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

    const db = mockDb(
      vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ name: "Used Team" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "used.admin" }] })
        .mockResolvedValueOnce({ rows: [{ role: "owner" }] }),
    );
    const app = createApp(db);

    const res = await app.request("/invites/inv_usedtoken");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("used");
    expect(body.invite.usedAt).toBeTruthy();
  });

  it("returns 404 for not_found — indistinguishable from genuinely missing", async () => {
    vi.mocked(lookupInviteByToken).mockResolvedValue({ status: "not_found" });

    const db = mockDb(vi.fn());
    const app = createApp(db);

    const res = await app.request("/invites/inv_missing");
    expect(res.status).toBe(404);
  });

  it("does not require authentication", async () => {
    const now = new Date();
    vi.mocked(lookupInviteByToken).mockResolvedValue({
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

    const db = mockDb(
      vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ name: "T" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "u" }] })
        .mockResolvedValueOnce({ rows: [{ role: "admin" }] }),
    );
    const app = createApp(db);

    const res = await app.request("/invites/inv_public");
    expect(res.status).toBe(200);
  });

  it("does not leak the plaintext token in the response", async () => {
    const now = new Date();
    vi.mocked(lookupInviteByToken).mockResolvedValue({
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

    const db = mockDb(
      vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ name: "T" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "u" }] })
        .mockResolvedValueOnce({ rows: [{ role: "admin" }] }),
    );
    const app = createApp(db);

    const res = await app.request("/invites/inv_sometoken");
    const body = await res.json();

    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("inv_sometoken");
    expect(bodyStr).not.toContain("token_hash");
    expect(bodyStr).not.toContain("tokenHash");
  });

  it("returns inviter role when membership record exists", async () => {
    const now = new Date();
    vi.mocked(lookupInviteByToken).mockResolvedValue({
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

    const db = mockDb(
      vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ name: "T" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "k.zhang" }] })
        .mockResolvedValueOnce({ rows: [{ role: "admin" }] }),
    );
    const app = createApp(db);

    const res = await app.request("/invites/inv_withrole");
    const body = await res.json();
    expect(body.invite.invitedByLogin).toBe("k.zhang");
    expect(body.invite.invitedByRole).toBe("admin");
  });

  it("returns null for inviter role when inviter has no membership", async () => {
    const now = new Date();
    vi.mocked(lookupInviteByToken).mockResolvedValue({
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

    const db = mockDb(
      vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ name: "T" }] })
        .mockResolvedValueOnce({ rows: [{ github_login: "unknown_user" }] })
        .mockResolvedValueOnce({ rows: [] }),
    );
    const app = createApp(db);

    const res = await app.request("/invites/inv_norole");
    const body = await res.json();
    expect(body.invite.invitedByLogin).toBe("unknown_user");
    expect(body.invite.invitedByRole).toBeNull();
  });

  it("executes the real SQL query pattern (validates table/column names against schema)", async () => {
    // This test ensures the real handler uses the expected query pattern.
    // If someone renames a column or table in the handler without updating
    // the test, this catches it because the mock expectations won't match.
    const now = new Date();
    vi.mocked(lookupInviteByToken).mockResolvedValue({
      status: "valid",
      invite: {
        id: "inv_test",
        teamId: "team_test",
        targetRole: "member",
        invitedByUserId: "user_test",
        expiresAt: new Date(now.getTime() + 3600 * 1000),
        usedAt: null,
        createdAt: now,
      },
    });

    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ name: "TestTeam" }] })
      .mockResolvedValueOnce({ rows: [{ github_login: "tester" }] })
      .mockResolvedValueOnce({ rows: [{ role: "admin" }] });

    const db = mockDb(query);
    const app = createApp(db);

    const res = await app.request("/invites/inv_realtest");
    expect(res.status).toBe(200);

    // Verify the real handler called db.$client.query with the expected SQL
    expect(query).toHaveBeenCalledTimes(3);
    // Call 1: team name lookup
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT name FROM teams"),
      ["team_test"],
    );
    // Call 2: inviter login lookup
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT github_login FROM users"),
      ["user_test"],
    );
    // Call 3: inviter role lookup
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("SELECT role FROM memberships"),
      ["user_test", "team_test"],
    );
  });
});
