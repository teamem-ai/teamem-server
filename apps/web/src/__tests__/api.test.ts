import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookupInvite } from "@/lib/api";

describe("lookupInvite", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns not_found on HTTP 404 without fabricating fake data", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    } as unknown as Response);

    const result = await lookupInvite("inv_nonexistent");
    expect(result).toEqual({ status: "not_found" });
    expect(result).not.toHaveProperty("invite");
  });

  it("parses and validates a valid 200 response", async () => {
    const validResponse = {
      status: "valid",
      invite: {
        id: "inv_abc123",
        teamId: "team_xyz",
        teamName: "Acme Corp",
        targetRole: "member",
        invitedByLogin: "k.zhang",
        invitedByRole: "admin",
        expiresAt: "2026-07-24T00:00:00.000Z",
        usedAt: null,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(validResponse),
    } as unknown as Response);

    const result = await lookupInvite("inv_valid123");
    expect(result).toEqual(validResponse);
  });

  it("throws on an invalid 200 response that violates the contract", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          status: "valid",
          invite: {
            id: "inv_abc123",
            teamId: "unknown", // violates teamId regex
            teamName: "Acme Corp",
            targetRole: "member",
            invitedByLogin: "k.zhang",
            invitedByRole: "admin",
            expiresAt: "2026-07-24T00:00:00.000Z",
            usedAt: null,
          },
        }),
    } as unknown as Response);

    await expect(lookupInvite("inv_bad_team")).rejects.toThrow();
  });

  it("throws on non-404, non-200 error responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
    } as unknown as Response);

    await expect(lookupInvite("inv_error")).rejects.toThrow(
      "/invites/:token returned 500",
    );
  });
});
