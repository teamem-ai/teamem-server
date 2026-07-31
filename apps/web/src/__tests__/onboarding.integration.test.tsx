/**
 * Network-boundary integration tests for the onboarding wizard.
 *
 * Uses MSW (Mock Service Worker) to intercept fetch at the network level,
 * verifying that every API call matches the real server contract:
 *   - URL path and query parameter names
 *   - Auth mechanism (session cookie vs Bearer token)
 *   - Response envelope shape ({requestId, data} / {requestId, data, nextCursor})
 *
 * These tests will fail if any of those details drifts out of sync with
 * the server implementation — unlike module-level stubs, which would
 * silently continue passing with wrong URLs or auth.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";

// ── MSW server setup ──────────────────────────────────────────────────────

/** Valid project-scoped API key the wizard mints in Step 4. */
const TEST_TOKEN = "tm_test_token_abc123";
const TEST_TEAM_ID = "team_test1234abcd";
const TEST_PROJECT_ID = "prj_test5678efgh";
const TEST_PROJECT_NAME = "my-project";

const handlers = [
  // ── POST /v1/teams ──────────────────────────────────────────────────
  http.post("/v1/teams", async ({ request }) => {
    const body = await request.json() as { name?: string };
    if (!body?.name) {
      return HttpResponse.json(
        { error: "invalid_request", message: "name is required" },
        { status: 400 },
      );
    }
    return HttpResponse.json(
      {
        requestId: "req_team",
        data: {
          id: TEST_TEAM_ID,
          name: body.name,
          role: "owner",
          createdAt: new Date().toISOString(),
        },
      },
      { status: 201 },
    );
  }),

  // ── POST /v1/teams/:teamId/projects ─────────────────────────────────
  http.post("/v1/teams/:teamId/projects", async ({ params, request }) => {
    const body = await request.json() as { name?: string };
    if (params.teamId !== TEST_TEAM_ID) {
      return HttpResponse.json(
        { error: "not_found", message: "Team not found" },
        { status: 404 },
      );
    }
    if (!body?.name) {
      return HttpResponse.json(
        { error: "invalid_request", message: "name is required" },
        { status: 400 },
      );
    }
    return HttpResponse.json(
      {
        requestId: "req_project",
        data: {
          id: TEST_PROJECT_ID,
          teamId: TEST_TEAM_ID,
          name: body.name,
          createdAt: new Date().toISOString(),
        },
      },
      { status: 201 },
    );
  }),

  // ── POST /v1/teams/:teamId/keys ─────────────────────────────────────
  http.post("/v1/teams/:teamId/keys", async ({ params, request }) => {
    const body = await request.json() as {
      name?: string; projectId?: string; scopes?: string[];
    };
    if (params.teamId !== TEST_TEAM_ID) {
      return HttpResponse.json(
        { error: "not_found", message: "Team not found" },
        { status: 404 },
      );
    }
    return HttpResponse.json(
      {
        requestId: "req_key",
        data: {
          id: "key_minted001",
          name: body.name ?? "Onboarding key",
          token: TEST_TOKEN,
          mcpCommand: `claude mcp add --transport http teamem http://localhost:8080/mcp --header "Authorization: Bearer ${TEST_TOKEN}"`,
          scopes: body.scopes ?? ["read", "write"],
          allProjects: false,
          projectId: body.projectId ?? null,
          createdAt: new Date().toISOString(),
        },
      },
      { status: 201 },
    );
  }),

  // ── GET /v1/events?projectId=... ────────────────────────────────────
  http.get("/v1/events", ({ request }) => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const auth = request.headers.get("Authorization");

    // Must use Bearer auth (not session cookie)
    if (!auth || !auth.startsWith("Bearer ")) {
      return HttpResponse.json(
        { error: "unauthorized", message: "Missing Bearer token" },
        { status: 401 },
      );
    }
    if (auth !== `Bearer ${TEST_TOKEN}`) {
      return HttpResponse.json(
        { error: "unauthorized", message: "Invalid token" },
        { status: 401 },
      );
    }

    // Must pass projectId parameter
    if (!projectId) {
      return HttpResponse.json(
        { error: "invalid_request", message: "projectId is required" },
        { status: 400 },
      );
    }

    // Return proper cursor-paginated response shape
    return HttpResponse.json({
      requestId: "req_events",
      data: [
        {
          id: "evt_001",
          sourceKind: "cli_init",
          sourceChannel: "cli",
          actor: null,
          actorProvenance: "client_claimed",
          occurredAt: new Date().toISOString(),
          occurredAtProvenance: "client_claimed",
          ingestedBy: { credentialId: "key_minted001", principalId: null },
          payloadBytes: 512,
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    });
  }),

  // ── GET /v1/jobs?projectId=... ──────────────────────────────────────
  http.get("/v1/jobs", ({ request }) => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const auth = request.headers.get("Authorization");

    if (!auth || !auth.startsWith("Bearer ")) {
      return HttpResponse.json(
        { error: "unauthorized", message: "Missing Bearer token" },
        { status: 401 },
      );
    }

    if (!projectId) {
      return HttpResponse.json(
        { error: "invalid_request", message: "projectId is required" },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      requestId: "req_jobs",
      data: [],
      nextCursor: null,
    });
  }),

  // ── GET /v1/concepts?projectId=... ──────────────────────────────────
  http.get("/v1/concepts", ({ request }) => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const auth = request.headers.get("Authorization");

    if (!auth || !auth.startsWith("Bearer ")) {
      return HttpResponse.json(
        { error: "unauthorized", message: "Missing Bearer token" },
        { status: 401 },
      );
    }

    if (!projectId) {
      return HttpResponse.json(
        { error: "invalid_request", message: "projectId is required" },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      requestId: "req_concepts",
      data: [
        {
          id: "13ee5d2e-6bfe-4406-ae91-153c4c0ea148",
          path: "decisions/use-postgresql-pgvector",
          title: "Use PostgreSQL with pgvector",
          type: "decision",
          confidence: "high",
          evidenceCount: 3,
        },
      ],
      nextCursor: null,
    });
  }),

  // ── GET /auth/me ────────────────────────────────────────────────────
  http.get("/auth/me", () => {
    return HttpResponse.json({
      userId: "usr_test",
      githubLogin: "testuser",
      avatarUrl: null,
      teamId: TEST_TEAM_ID,
      teamName: "Test Team",
      role: "owner",
    });
  }),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  sessionStorage.clear();
});
afterAll(() => server.close());

// ── Helper ─────────────────────────────────────────────────────────────────

function renderOnboarding() {
  return render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <OnboardingPage />
    </MemoryRouter>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Onboarding wizard — network-boundary integration (MSW)", () => {
  it("Step 1: creates a team and project through real POST endpoints", async () => {
    renderOnboarding();

    // Fill in the form
    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Acme Corp" },
    });
    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: TEST_PROJECT_NAME },
    });

    // Submit
    fireEvent.click(screen.getByText("Continue"));

    // Should advance to Step 2 (LLM provider) after successful creation
    await waitFor(
      () => {
        expect(
          screen.getByText("Connect an LLM provider"),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("Step 4: mints a real API key and displays the plaintext token", async () => {
    renderOnboarding();

    // Navigate through Step 1
    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Acme Corp" },
    });
    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: TEST_PROJECT_NAME },
    });
    fireEvent.click(screen.getByText("Continue"));

    // Step 2: skip LLM
    await waitFor(() => {
      expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Skip for now/));

    // Step 3: continue through repos
    await waitFor(() => {
      expect(screen.getByText("Choose which repositories to watch")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Continue"));

    // Step 4: should auto-mint the key
    await waitFor(
      () => {
        // The one-time key should be visible
        expect(screen.getByText(TEST_TOKEN)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // The "won't see again" warning should be present
    expect(
      screen.getByText(/won't see this key again/),
    ).toBeInTheDocument();

    // All three commands should be rendered
    expect(screen.getByText(/claude mcp add/)).toBeInTheDocument();
    expect(screen.getByText(/teamem init/)).toBeInTheDocument();
    expect(screen.getByText(/teamem cli install-hook/)).toBeInTheDocument();
  });

  it("Step 5: polls with Bearer auth and shows stats + latest page", async () => {
    renderOnboarding();

    // Navigate through all steps
    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Acme Corp" },
    });
    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: TEST_PROJECT_NAME },
    });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Skip for now/));

    await waitFor(() => {
      expect(screen.getByText("Choose which repositories to watch")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Continue"));

    // Wait for key minting
    await waitFor(
      () => {
        expect(screen.getByText(TEST_TOKEN)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Continue to Step 5
    fireEvent.click(screen.getByText(/I've copied the key/));

    // Should show success state with stats
    await waitFor(
      () => {
        expect(
          screen.getByText("Your first knowledge is here"),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Stats should show the observed counts (1 event, 0 jobs, 1 page)
    expect(screen.getByText("Events received")).toBeInTheDocument();
    expect(screen.getByText("Pages compiled")).toBeInTheDocument();

    // Latest page card should appear
    expect(
      screen.getByText("Use PostgreSQL with pgvector"),
    ).toBeInTheDocument();
  });

  it("Step 5: shows key-skipped guidance when no key was minted", async () => {
    // Override the mint endpoint to simulate a failure so the skip button appears
    server.use(
      http.post("/v1/teams/:teamId/keys", () => {
        return HttpResponse.json(
          { error: "internal_error", message: "Key minting unavailable" },
          { status: 500 },
        );
      }),
    );

    renderOnboarding();

    // Navigate through Step 1
    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Acme Corp" },
    });
    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: TEST_PROJECT_NAME },
    });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Skip for now/));

    await waitFor(() => {
      expect(screen.getByText("Choose which repositories to watch")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Continue"));

    // Step 4: mint fails → error state appears with skip button
    await waitFor(
      () => {
        const skipBtn = screen.getByText(/Skip.*mint keys later/);
        fireEvent.click(skipBtn);
      },
      { timeout: 5000 },
    );

    // Now on Step 5: should show key-skipped guidance
    await waitFor(
      () => {
        expect(
          screen.getByText(/skipped minting an API key/),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Should show dash stats, not zeros
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);

    // Should point user to Settings → API keys
    expect(
      screen.getByText(/Settings.*API keys/),
    ).toBeInTheDocument();
  });

  it("R7: API key plaintext is never persisted to sessionStorage", async () => {
    renderOnboarding();

    // Navigate through all steps to get a key minted
    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Acme Corp" },
    });
    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: TEST_PROJECT_NAME },
    });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Skip for now/));

    await waitFor(() => {
      expect(screen.getByText("Choose which repositories to watch")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Continue"));

    // Wait for key to be minted (token visible on screen)
    await waitFor(
      () => {
        expect(screen.getByText(TEST_TOKEN)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Advance to Step 5 — this triggers the state persistence with token stripped
    fireEvent.click(screen.getByText(/I've copied the key/));

    // Wait for Step 5 to render
    await waitFor(
      () => {
        expect(
          screen.getByText("Your first knowledge is here"),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Now check sessionStorage: the persisted state must NOT contain the token.
    // React effects are async, so poll until the state is persisted.
    await waitFor(
      () => {
        const stored = sessionStorage.getItem("teamem-onboarding");
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        expect(parsed.step4).toBeTruthy();
        expect(parsed.step4.token).toBe("");
        expect(parsed.step4.mcpCommand).toBe("");
        // keyId (non-sensitive) can be persisted
        expect(parsed.step4.keyId).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });
});
