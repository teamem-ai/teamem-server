import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import {
  fetchConcept,
  fetchConcepts,
  fetchContext,
  fetchMe,
  fetchProjects,
  searchConcepts,
  lookupInvite,
  downloadExportFile,
} from "@/lib/api";

/**
 * API client tests — stub global.fetch at the network boundary and verify
 * the client unwraps the real server envelopes (N3):
 *   - itemResponse: { requestId, data }
 *   - listResponse: { requestId, data, nextCursor }
 *   - searchResponse: flat { requestId, results, degraded, nextCursor }
 *   - contextResponse: { requestId, data: { markdown, ... } }
 *
 * The fetchConcept envelope unwrap is the regression test for the review
 * blocker: the page crashed because the client returned the raw envelope.
 */

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchConcept", () => {
  it("unwraps the itemResponse envelope and returns the concept", async () => {
    const concept = {
      schemaVersion: 1,
      uuid: "13ee5d2e-6bfe-4406-ae91-153c4c0ea148",
      path: "decisions/use-postgresql-pgvector",
      type: "decision",
      status: "active",
      confidence: "high",
      title: "Use PostgreSQL",
      tags: ["postgres"],
      lastConfirmed: "2026-07-28T04:03:20.624Z",
      firstSeen: "2026-07-28T04:02:17.218Z",
      contributors: [],
      evidence: [
        { kind: "pr", ref: "https://github.com/x/y/pull/1", at: "2026-07-28T02:00:00Z" },
      ],
      supersedes: null,
      aliases: [],
      body: "## Decision",
      createdAt: "2026-07-28T04:02:22.374Z",
    };
    mockFetch.mockResolvedValue(
      jsonResponse(200, { requestId: "req_1", data: concept }),
    );

    const result = await fetchConcept(concept.uuid, "prj_abc");
    expect(result.uuid).toBe(concept.uuid);
    expect(result.body).toBe("## Decision");
    // Must NOT be the raw envelope
    expect((result as unknown as Record<string, unknown>)["data"]).toBeUndefined();
  });

  it("throws ApiError with status on 404", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(404, { error: { code: "not_found", message: "Concept not found" } }),
    );
    await expect(fetchConcept("x", "prj_abc")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });

  it("throws ApiError with status 401 on unauthorized", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(401, { error: { code: "unauthorized", message: "invalid or revoked API key" } }),
    );
    await expect(fetchConcept("x", "prj_abc")).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("fetchConcepts", () => {
  it("returns the listResponse envelope with data and nextCursor", async () => {
    const summary = {
      uuid: "13ee5d2e-6bfe-4406-ae91-153c4c0ea148",
      path: "decisions/x",
      type: "decision",
      status: "active",
      confidence: "high",
      title: "X",
      tags: [],
      lastConfirmed: "2026-07-28T04:03:20.624Z",
      evidenceCount: 2,
      contributors: [{ principalId: "pri_test", kind: "human", provider: "github", displayName: "test" }],
    };
    mockFetch.mockResolvedValue(
      jsonResponse(200, { requestId: "req_2", data: [summary], nextCursor: "cursor_9" }),
    );

    const result = await fetchConcepts({ projectId: "prj_abc" });
    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBe("cursor_9");
    expect(result.requestId).toBe("req_2");
  });

  it("passes type/status/tag/contributor filters as query params", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { requestId: "r", data: [], nextCursor: null }),
    );
    await fetchConcepts({
      projectId: "prj_abc",
      type: "gotcha",
      status: "disputed",
      tag: "postgres",
      contributor: "pri_xyz",
    });
    const url = new URL(mockFetch.mock.calls[0]![0] as string);
    expect(url.searchParams.get("type")).toBe("gotcha");
    expect(url.searchParams.get("status")).toBe("disputed");
    expect(url.searchParams.get("tag")).toBe("postgres");
    expect(url.searchParams.get("contributor")).toBe("pri_xyz");
  });
});

describe("searchConcepts", () => {
  it("posts the query and returns the flat searchResponse", async () => {
    const respBody = {
      requestId: "req_3",
      results: [
        {
          uuid: "u1",
          path: "decisions/x",
          type: "decision",
          status: "active",
          confidence: "high",
          title: "X",
          tags: [],
          lastConfirmed: "2026-07-28T04:03:20.624Z",
          evidenceCount: 2,
          contributors: [{ principalId: "pri_test", kind: "human", provider: "github", displayName: "test" }],
          relevance: 0.36,
          ftsFallback: false,
        },
      ],
      degraded: false,
      nextCursor: null,
    };
    mockFetch.mockResolvedValue(jsonResponse(200, respBody));

    const result = await searchConcepts({
      projectId: "prj_abc",
      query: "why postgres",
      type: "decision",
      status: "active",
    });
    expect(result.results).toHaveLength(1);
    expect(result.degraded).toBe(false);

    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/v1/search");
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("why postgres");
    expect(body.type).toBe("decision");
    expect(body.status).toBe("active");
  });
});

describe("fetchContext", () => {
  it("returns the contextResponse envelope", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        requestId: "req_4",
        data: {
          markdown: "# Team Context\n",
          budgetUsed: 3,
          conceptsIncluded: 0,
          conceptsAvailable: 0,
        },
      }),
    );
    const result = await fetchContext("prj_abc");
    expect(result.data.conceptsIncluded).toBe(0);
    expect(result.requestId).toBe("req_4");
  });
});

describe("session scope endpoints", () => {
  it("fetchMe returns the flat session object", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        userId: "usr_1",
        githubLogin: "dli",
        avatarUrl: null,
        teamId: "team_1",
        teamName: "Acme",
        role: "member",
      }),
    );
    const me = await fetchMe();
    expect(me.role).toBe("member");
    expect(me.teamId).toBe("team_1");
  });

  it("fetchProjects unwraps the data array", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        requestId: "req_5",
        data: [
          { id: "prj_1", teamId: "team_1", name: "web-app", createdAt: "2026-07-01T00:00:00Z" },
        ],
      }),
    );
    const projects = await fetchProjects("team_1");
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe("prj_1");
  });
});

// ── OKF export (M3-EXPORT-05: consumes GET /v1/export) ──────────────────────

describe("downloadExportFile", () => {
  it("requests /v1/export with the projectId and returns the archive + server filename", async () => {
    mockFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([31, 139, 8, 0])]), {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": 'attachment; filename="web-app-okf-0.1.tar.gz"',
        },
      }),
    );

    const result = await downloadExportFile("prj_abc");
    expect(result.filename).toBe("web-app-okf-0.1.tar.gz");
    expect(result.blob.type).toBe("application/gzip");

    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/v1/export");
    expect(new URL(url).searchParams.get("projectId")).toBe("prj_abc");
    // Same-origin web session cookie, GET only.
    expect((init as RequestInit).credentials).toBe("same-origin");
  });

  it("throws ApiError with the server envelope message on 403", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(403, {
        error: { code: "forbidden", message: "forbidden" },
      }),
    );

    await expect(downloadExportFile("prj_abc")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      code: "forbidden",
      message: "forbidden",
    });
  });

  it("throws AuditWriteFailedError when the export is blocked by a failed audit record (fail-closed, N7)", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(500, {
        error: {
          code: "internal",
          message: "Export audit failed; download denied",
          details: { audit_failed: true },
        },
      }),
    );

    await expect(downloadExportFile("prj_abc")).rejects.toMatchObject({
      name: "AuditWriteFailedError",
      status: 500,
    });
  });

  it("throws ApiError for a non-JSON failure response instead of guessing", async () => {
    mockFetch.mockResolvedValue(
      new Response("oops", { status: 502, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(downloadExportFile("prj_abc")).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
    });
  });

  it("refuses a 200 that is not a gzip archive (contract violation, never a broken download)", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "html" }), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(downloadExportFile("prj_abc")).rejects.toMatchObject({
      name: "ApiError",
      code: "unexpected_response",
    });
  });

  it("falls back to a deterministic filename when Content-Disposition is missing", async () => {
    mockFetch.mockResolvedValue(
      new Response(new Blob([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      }),
    );

    const result = await downloadExportFile("prj_abc");
    expect(result.filename).toBe("teamem-okf-0.1.tar.gz");
  });
});

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
