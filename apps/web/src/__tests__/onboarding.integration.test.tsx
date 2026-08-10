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
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";

// ── MSW server setup ──────────────────────────────────────────────────────

/** Valid project-scoped API key the wizard mints in Step 4. */
const TEST_TOKEN = "tm_test_token_abc123";
const TEST_TEAM_ID = "team_test1234abcd";
const TEST_PROJECT_ID = "prj_test5678efgh";
const TEST_PROJECT_NAME = "my-project";

/** Counts POST /v1/teams calls so tests can assert a second team was NOT created. */
let teamCreateCalls = 0;

const handlers = [
  // ── POST /v1/teams ──────────────────────────────────────────────────
  http.post("/v1/teams", async ({ request }) => {
    teamCreateCalls += 1;
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

  // ── PATCH /v1/teams/:teamId (rename) ────────────────────────────────
  http.patch("/v1/teams/:teamId", async ({ params, request }) => {
    const body = (await request.json()) as { name?: string };
    if (params.teamId !== TEST_TEAM_ID) {
      return HttpResponse.json({ error: "not_found", message: "Team not found" }, { status: 404 });
    }
    if (!body?.name) {
      return HttpResponse.json({ error: "invalid_request", message: "name is required" }, { status: 400 });
    }
    return HttpResponse.json({
      requestId: "req_rename",
      data: { id: TEST_TEAM_ID, name: body.name },
    });
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
  // Real API scopes (packages/schema/src/auth.ts): "events:write", "read",
  // "read:payload", "audit:read" — deliberately no bare "write". Validating
  // this here (instead of accepting anything) is what would have caught the
  // client sending the nonexistent "write" scope.
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
    const VALID_SCOPES = ["events:write", "read", "read:payload", "audit:read"];
    const scopes = body.scopes ?? ["read"];
    if (scopes.some((s) => !VALID_SCOPES.includes(s))) {
      return HttpResponse.json(
        { requestId: "req_key_invalid", error: { code: "invalid_request", message: "Bad request" } },
        { status: 400 },
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
          scopes,
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

  // ── GET /v1/teams/:teamId/projects ──────────────────────────────────
  http.get("/v1/teams/:teamId/projects", () => {
    return HttpResponse.json({ requestId: "req_projects", data: [] });
  }),

  // ── GET /auth/me ────────────────────────────────────────────────────
  // Default: the common real case — GitHub OAuth already auto-bootstrapped
  // a team for this user (ensureTeamMembership), but no project yet. A
  // teamId:null session is deliberately NOT the default here: once any
  // team exists on the instance, the wizard blocks that state instead of
  // offering self-serve team creation (see the dedicated "blocked" test).
  http.get("/auth/me", () => {
    return HttpResponse.json({
      userId: "usr_test",
      githubLogin: "testuser",
      avatarUrl: null,
      teamId: TEST_TEAM_ID,
      teamName: "testuser's Team",
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
  teamCreateCalls = 0;
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

/** Renders OnboardingPage alongside /login and /knowledge so entry-guard
 *  redirects (which target those real routes) are observable in tests. */
function renderOnboardingWithRouting() {
  return render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/login" element={<div>LOGIN_PAGE_MARKER</div>} />
        <Route path="/knowledge" element={<div>KNOWLEDGE_PAGE_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Fills and submits Step 1. The wizard now gates its first render behind an
 * async entry-guard check (GET /auth/me, and GET .../projects when a team
 * exists) — the form is not present synchronously after render(), so this
 * must wait for it rather than querying immediately.
 */
async function fillStep1(teamName: string, projectName: string) {
  await waitFor(() => {
    expect(screen.getByLabelText("Team name")).toBeInTheDocument();
  });
  fireEvent.change(screen.getByLabelText("Team name"), {
    target: { value: teamName },
  });
  fireEvent.change(screen.getByLabelText("First project"), {
    target: { value: projectName },
  });
  fireEvent.click(screen.getByText("Continue"));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Onboarding wizard — network-boundary integration (MSW)", () => {
  it("Step 1: renames the auto-bootstrapped team and creates the first project through real endpoints", async () => {
    renderOnboarding();

    await fillStep1("Acme Corp", TEST_PROJECT_NAME);

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
    await fillStep1("Acme Corp", TEST_PROJECT_NAME);

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

    // Codex connect config (DUA-255): the verified `codex mcp add` form with
    // --url + --bearer-token-env-var, host correctly filled from the session.
    expect(
      screen.getByText(
        /codex mcp add teamem --url http:\/\/localhost:3000\/mcp --bearer-token-env-var TEAMEM_MCP_TOKEN/,
      ),
    ).toBeInTheDocument();
    // The config.toml snippet referencing the env var is also offered.
    expect(
      screen.getByText(/\[mcp_servers\.teamem\]/),
    ).toBeInTheDocument();
    // Security: the Codex *command* must not embed the plaintext token (it is
    // referenced via the env var); the token appears only in the export wiring.
    const codexCommand = screen.getByText(
      /codex mcp add teamem --url http:\/\/localhost:3000\/mcp --bearer-token-env-var TEAMEM_MCP_TOKEN/,
    );
    expect(codexCommand.textContent).not.toContain(TEST_TOKEN);
    expect(
      screen.getByText(`export TEAMEM_MCP_TOKEN="${TEST_TOKEN}"`),
    ).toBeInTheDocument();
  });

  it("Step 5: polls with Bearer auth and shows stats + latest page", async () => {
    renderOnboarding();

    // Navigate through all steps
    await fillStep1("Acme Corp", TEST_PROJECT_NAME);

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
    await fillStep1("Acme Corp", TEST_PROJECT_NAME);

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
    await fillStep1("Acme Corp", TEST_PROJECT_NAME);

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

// ── Entry guard ──────────────────────────────────────────────────────────
// Covers the real gaps found in hands-on testing: /onboarding rendered for
// signed-out visitors, and revisiting it after onboarding was already done
// (a team alone doesn't mean "done" — every first GitHub login auto-
// bootstraps a team; a project does).

describe("Onboarding wizard — entry guard", () => {
  it("shows the GitHub sign-in step (not a /login redirect) when signed out", async () => {
    server.use(
      http.get("/auth/me", () => new HttpResponse(null, { status: 401 })),
    );

    renderOnboardingWithRouting();

    // The wizard is the front door: sign-in lives inside it, so a signed-out
    // visitor sees the sign-in step, not a bounce to a separate /login page.
    await waitFor(() => {
      expect(screen.getByText("Set up your teamem portal")).toBeInTheDocument();
    });
    const signIn = screen.getByRole("link", { name: /Sign in with GitHub/i });
    expect(signIn).toHaveAttribute("href", "/auth/github");
    expect(screen.queryByText("LOGIN_PAGE_MARKER")).toBeNull();
  });

  it("blocks self-serve team creation (not the fresh-signup wizard) for a signed-in session with no team", async () => {
    // This is the state a removed or never-invited visitor lands in — see
    // the entry-guard comment above. ensureTeamMembership only ever returns
    // null here once some team already exists on the instance, so this must
    // never fall back to the self-serve "create your own team" wizard (the
    // server rejects that POST anyway — see teams.ts).
    server.use(
      http.get("/auth/me", () =>
        HttpResponse.json({
          userId: "usr_blocked",
          githubLogin: "removed_user",
          avatarUrl: null,
          teamId: null,
          teamName: null,
          role: null,
        }),
      ),
    );

    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByText("No team access")).toBeInTheDocument();
    });
    expect(screen.getByText(/removed_user/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Team name")).toBeNull();
    expect(teamCreateCalls).toBe(0);
  });

  it("redirects to /knowledge when the team already has a project", async () => {
    server.use(
      http.get("/auth/me", () =>
        HttpResponse.json({
          userId: "usr_test",
          githubLogin: "testuser",
          avatarUrl: null,
          teamId: TEST_TEAM_ID,
          teamName: "Test Team",
          role: "owner",
        }),
      ),
      http.get("/v1/teams/:teamId/projects", () =>
        HttpResponse.json({
          requestId: "req_projects",
          data: [
            { id: TEST_PROJECT_ID, teamId: TEST_TEAM_ID, name: TEST_PROJECT_NAME, createdAt: new Date().toISOString() },
          ],
        }),
      ),
    );

    renderOnboardingWithRouting();

    await waitFor(() => {
      expect(screen.getByText("KNOWLEDGE_PAGE_MARKER")).toBeInTheDocument();
    });
  });

  it("resumes at Step 1 with the existing team when one exists with zero projects", async () => {
    // Simulates the common real case: GitHub OAuth auto-bootstrapped a
    // team for this user already (ensureTeamMembership), but they never
    // created a project. The default /v1/teams/:teamId/projects handler
    // already returns [].
    server.use(
      http.get("/auth/me", () =>
        HttpResponse.json({
          userId: "usr_test",
          githubLogin: "testuser",
          avatarUrl: null,
          teamId: TEST_TEAM_ID,
          teamName: "Test Team",
          role: "owner",
        }),
      ),
    );

    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByText("Name your team & first project")).toBeInTheDocument();
    });

    // Both fields are offered; the team name is pre-filled with the
    // auto-bootstrapped placeholder so the user can rename it.
    const teamInput = screen.getByLabelText("Team name") as HTMLInputElement;
    expect(teamInput.value).toBe("Test Team");

    // Rename the team and create the first project.
    fireEvent.change(teamInput, { target: { value: "Renamed Team" } });
    fireEvent.change(screen.getByLabelText("First project"), {
      target: { value: TEST_PROJECT_NAME },
    });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
    });

    // Must reuse the existing team (rename), not mint a second one.
    expect(teamCreateCalls).toBe(0);
  });

  it("discards stale later-step progress and restarts at Step 1 when no project exists", async () => {
    // Regression: persisted wizard state can point at a project that no
    // longer exists (e.g. the DB was reset since it was saved). Without a
    // reset, the wizard jumps straight to step 4 and mints a key against
    // the dead project id → HTTP 404. The entry guard must restart at step 1.
    sessionStorage.setItem(
      "teamem-onboarding",
      JSON.stringify({
        currentStep: 4,
        step1: {
          team: { id: "team_old", name: "Old", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
          project: { id: "prj_gone", teamId: "team_old", name: "gone", createdAt: "2026-01-01T00:00:00.000Z" },
        },
        completed: false,
      }),
    );

    server.use(
      http.get("/auth/me", () =>
        HttpResponse.json({
          userId: "usr_test",
          githubLogin: "testuser",
          avatarUrl: null,
          teamId: TEST_TEAM_ID,
          teamName: "Test Team",
          role: "owner",
        }),
      ),
    );

    renderOnboarding();

    // Lands on step 1, NOT the stale step 4 ("Connect your agent").
    await waitFor(() => {
      expect(screen.getByText("Name your team & first project")).toBeInTheDocument();
    });
    expect(screen.queryByText("Connect your agent")).toBeNull();
  });
});
