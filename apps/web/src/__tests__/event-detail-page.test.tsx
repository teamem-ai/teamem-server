import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { EventDetailPage } from "@/pages/event-detail-page";
import { ScopeProvider } from "@/lib/scope";

/**
 * Event detail page tests. The mcp_write evidence in concept detail links
 * to /events/:id; this page must exist and render the real event payload.
 */

const mocks = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  fetchProjects: vi.fn(),
  fetchEvent: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchMe: (...args: unknown[]) => mocks.fetchMe(...args),
  fetchProjects: (...args: unknown[]) => mocks.fetchProjects(...args),
  fetchEvent: (...args: unknown[]) => mocks.fetchEvent(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  },
}));

const MEMBER_SESSION = {
  userId: "usr_1",
  githubLogin: "dli",
  avatarUrl: null,
  teamId: "team_1",
  teamName: "Acme Corp",
  role: "member" as const,
};

const PROJECTS = [
  { id: "prj_webapp", teamId: "team_1", name: "web-app", createdAt: "2026-07-01T00:00:00Z" },
];

const MOCK_EVENT = {
  id: "evt_53014880b618482c94dc28ac167acee9",
  projectId: "prj_webapp",
  source: {
    channel: "mcp",
    kind: "mcp_write",
    deliveryId: "mcp_123",
    itemKey: "root",
    externalId: "mcp_123",
  },
  actor: {
    kind: "human" as const,
    providerUserId: "12345",
    displayLogin: "dli",
    provider: "github",
  },
  actorProvenance: "credential_bound",
  occurredAt: "2026-07-28T12:19:43.225Z",
  occurredAtProvenance: "provider",
  ingestedBy: {
    credentialId: "key_abc",
    principalId: "pri_dli",
  },
  payloadBytes: 42,
  createdAt: "2026-07-28T12:19:43.225Z",
  payload: {
    action: "record",
    body: "Stripe webhooks may retry.",
  },
};

function renderEvent(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/events/${id}`]}>
      <ScopeProvider>
        <Routes>
          <Route path="/events/:id" element={<EventDetailPage />} />
        </Routes>
      </ScopeProvider>
    </MemoryRouter>,
  );
}

describe("EventDetailPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  function setupScope() {
    mocks.fetchMe.mockResolvedValue(MEMBER_SESSION);
    mocks.fetchProjects.mockResolvedValue(PROJECTS);
  }

  it("renders event source, actor, payload, and ingested-by", async () => {
    setupScope();
    mocks.fetchEvent.mockResolvedValue(MOCK_EVENT);
    renderEvent(MOCK_EVENT.id);

    expect(await screen.findByText(`Event ${MOCK_EVENT.id}`)).toBeInTheDocument();
    expect(screen.getByText("mcp_write")).toBeInTheDocument();
    expect(screen.getByText("mcp")).toBeInTheDocument();
    expect(screen.getByText("Redacted payload")).toBeInTheDocument();
    expect(screen.getByText(/"action": "record"/)).toBeInTheDocument();
    expect(screen.getByText("dli")).toBeInTheDocument();
    expect(screen.getByText("credential_bound")).toBeInTheDocument();
    expect(screen.getByText(/credential: key_abc/)).toBeInTheDocument();
  });

  it("fetches with the real session project ID", async () => {
    setupScope();
    mocks.fetchEvent.mockResolvedValue(MOCK_EVENT);
    renderEvent(MOCK_EVENT.id);
    await screen.findByText(`Event ${MOCK_EVENT.id}`);
    expect(mocks.fetchEvent).toHaveBeenCalledWith(MOCK_EVENT.id, "prj_webapp");
  });

  it("shows 404 NotFound for missing events", async () => {
    setupScope();
    const { ApiError } = await import("@/lib/api");
    mocks.fetchEvent.mockRejectedValue(new ApiError(404, "not_found", "Event not found"));
    renderEvent("evt_missing");

    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });

  it("shows honest 403 when session lacks read:payload scope", async () => {
    setupScope();
    const { ApiError } = await import("@/lib/api");
    mocks.fetchEvent.mockRejectedValue(new ApiError(403, "forbidden", "Forbidden"));
    renderEvent(MOCK_EVENT.id);

    expect(
      await screen.findByText(/does not have permission to read raw event payloads/),
    ).toBeInTheDocument();
  });
});
