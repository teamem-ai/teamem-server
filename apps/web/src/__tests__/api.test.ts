import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import {
  fetchConcept,
  fetchConcepts,
  fetchContext,
  fetchMe,
  fetchProjects,
  searchConcepts,
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
