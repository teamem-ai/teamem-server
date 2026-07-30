import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { AuditPage } from "@/pages/audit-page";
import { SoonPage } from "@/pages/soon-page";
import { SoonPlaceholder } from "@/components/ui/soon-placeholder";
import { NotFound } from "@/components/ui/not-found";

// ── MSW server for API mocking ─────────────────────────────────────────────

const server = setupServer(
  http.get("/v1/audit", () => {
    return HttpResponse.json({
      requestId: "test-req-001",
      data: [],
      nextCursor: null,
    });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});

// ── AuditPage tests ─────────────────────────────────────────────────────────

describe("AuditPage", () => {
  it("renders the page header with title and metadata-only subtitle", async () => {
    render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Audit log")).toBeInTheDocument();
    expect(
      screen.getByText(/Metadata only/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/query text and payloads are never stored here/)
    ).toBeInTheDocument();
  });

  it("shows empty state when there are no audit records", async () => {
    render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByText("No audit records in this range")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Reads, searches and payload access will appear here/)
    ).toBeInTheDocument();
  });

  it("shows the six-column table when data is loaded", async () => {
    server.use(
      http.get("/v1/audit", () => {
        return HttpResponse.json({
          requestId: "test-req-001",
          data: [
            {
              id: "aud_0000000000000001",
              createdAt: new Date().toISOString(),
              requestId: "69fa9eac12345678",
              principalId: "11111111-1111-1111-1111-111111111111",
              credentialId: null,
              action: "concept.read",
              resourceType: "concept",
              resourceId: "22222222-2222-2222-2222-222222222222",
              teamId: "33333333-3333-3333-3333-333333333333",
              projectId: "44444444-4444-4444-4444-444444444444",
              outcome: "success",
            },
          ],
          nextCursor: null,
        });
      })
    );

    render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    // Wait for the data row action text to appear (table is rendered)
    expect(await screen.findByText("concept.read")).toBeInTheDocument();
    // Verify table structure
    expect(screen.getByText("success")).toBeInTheDocument();
  });

  it("shows denied outcome as a red pill", async () => {
    server.use(
      http.get("/v1/audit", () => {
        return HttpResponse.json({
          requestId: "test-req-002",
          data: [
            {
              id: "aud_0000000000000002",
              createdAt: new Date().toISOString(),
              requestId: "d17b3c6012345678",
              principalId: "11111111-1111-1111-1111-111111111111",
              credentialId: null,
              action: "search.query",
              resourceType: "project",
              resourceId: null,
              teamId: "33333333-3333-3333-3333-333333333333",
              projectId: "44444444-4444-4444-4444-444444444444",
              outcome: "denied",
            },
          ],
          nextCursor: null,
        });
      })
    );

    render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("denied")).toBeInTheDocument();
  });

  it("has no expandable rows or content columns", async () => {
    server.use(
      http.get("/v1/audit", () => {
        return HttpResponse.json({
          requestId: "test-req-003",
          data: [
            {
              id: "aud_0000000000000003",
              createdAt: new Date().toISOString(),
              requestId: "bbbbbbbbbbbbbbbb",
              principalId: "11111111-1111-1111-1111-111111111111",
              credentialId: null,
              action: "event.payload_read",
              resourceType: "event",
              resourceId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
              teamId: "33333333-3333-3333-3333-333333333333",
              projectId: "44444444-4444-4444-4444-444444444444",
              outcome: "success",
            },
          ],
          nextCursor: null,
        });
      })
    );

    const { container } = render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    await screen.findByText("event.payload_read");

    // No expandable element: no <details>, no <summary>, no accordion triggers
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();

    // No sensitive content in the table rows themselves (subtitle is fine re "query text")
    // Verify the table cells don't contain payload-like data
    const tableBody = container.querySelector("tbody");
    const bodyText = tableBody?.textContent?.toLowerCase() ?? "";
    expect(bodyText).not.toContain("payload:");
    expect(bodyText).not.toContain("request body");
    expect(bodyText).not.toContain("expand");
  });

  it("shows filter chips for actor, action, project, and time range", async () => {
    render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    await screen.findByText("Audit log");

    expect(screen.getByText("Actor")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByText("Time range")).toBeInTheDocument();

    // Hint about mcp.* actions
    expect(
      screen.getByText(/via agent/)
    ).toBeInTheDocument();
  });

  it("shows PermissionDenied on 403 (role too low)", async () => {
    server.use(
      http.get("/v1/audit", () => {
        return new HttpResponse(null, { status: 403 });
      })
    );

    render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    // Must render the shared PermissionDenied component, not a hand-rolled error
    expect(
      await screen.findByText("Higher role required")
    ).toBeInTheDocument();

    // Must mention the required role (admin) — PermissionDenied renders it in a <strong>
    expect(screen.getByText("admin", { selector: "strong" })).toBeInTheDocument();

    // Must NOT use misleading technical-failure wording
    expect(screen.queryByText("Unable to load audit records")).toBeNull();
    expect(screen.queryByText("You need a higher role to view the audit log.")).toBeNull();
  });

  it("shows error state on server failure (500)", async () => {
    server.use(
      http.get("/v1/audit", () => {
        return new HttpResponse(null, { status: 500 });
      })
    );

    render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByText("Unable to load audit records")
    ).toBeInTheDocument();

    // 500 should NOT render PermissionDenied
    expect(screen.queryByText("Higher role required")).toBeNull();
  });

  it("shows Unknown actor when both principalId and credentialId are null", async () => {
    server.use(
      http.get("/v1/audit", () => {
        return HttpResponse.json({
          requestId: "test-req-004",
          data: [
            {
              id: "aud_0000000000000004",
              createdAt: new Date().toISOString(),
              requestId: "cccccccccccccccc",
              principalId: null,
              credentialId: null,
              action: "compilation.request",
              resourceType: "job",
              resourceId: "jjjjjjjj-jjjj-jjjj-jjjj-jjjjjjjjjjjj",
              teamId: "33333333-3333-3333-3333-333333333333",
              projectId: "44444444-4444-4444-4444-444444444444",
              outcome: "success",
            },
          ],
          nextCursor: null,
        });
      })
    );

    render(
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Unknown")).toBeInTheDocument();
  });
});

// ── NotFound (unified 404) tests ────────────────────────────────────────────

describe("NotFound", () => {
  it("shows the unified 404 text without access hints", () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>
    );

    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(
      screen.getByText(/This page doesn't exist, or the link is out of date/)
    ).toBeInTheDocument();

    // Must NOT mention access/permission (R3)
    expect(screen.queryByText(/access/i)).toBeNull();
    expect(screen.queryByText(/permission/i)).toBeNull();
    expect(screen.queryByText(/无权/i)).toBeNull();
  });

  it("links back to Knowledge", () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: /Back to Knowledge/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/knowledge");
  });
});

// ── SoonPlaceholder tests ───────────────────────────────────────────────────

describe("SoonPlaceholder", () => {
  it("renders the version badge and title", () => {
    render(<SoonPlaceholder title="Team digest" versionLabel="COMING IN V1.5" />);

    expect(screen.getByText("COMING IN V1.5")).toBeInTheDocument();
    expect(screen.getByText("Team digest")).toBeInTheDocument();
  });

  it("renders the description when provided", () => {
    render(
      <SoonPlaceholder
        title="Team digest"
        description="A weekly auto-compiled summary."
      />
    );

    expect(
      screen.getByText("A weekly auto-compiled summary.")
    ).toBeInTheDocument();
  });

  it("renders ghost card with example-not-live labeling when children are provided", () => {
    render(
      <SoonPlaceholder title="Test feature">
        <div>Ghost content</div>
      </SoonPlaceholder>
    );

    // Must include "example, not live data" labeling
    expect(
      screen.getByText(/example, not live data/)
    ).toBeInTheDocument();

    expect(screen.getByText("Ghost content")).toBeInTheDocument();
  });

  it("renders info banner when provided", () => {
    render(
      <SoonPlaceholder
        title="Test feature"
        infoBanner={<div>This is a placeholder.</div>}
      />
    );

    expect(screen.getByText("This is a placeholder.")).toBeInTheDocument();
  });

  it("is not clickable and does not contain interactive elements that imply functionality", () => {
    const { container } = render(
      <SoonPlaceholder title="Test feature">
        <div>Ghost content</div>
      </SoonPlaceholder>
    );

    // Version badge is a span, not a button
    expect(screen.getByText("COMING IN V1.5").tagName).toBe("SPAN");

    // The ghost card and its contents should not be buttons or links
    const ghostCard = container.querySelector(".ghost-card");
    expect(ghostCard).not.toBeNull();
    // No buttons inside ghost card
    expect(ghostCard?.querySelector("button")).toBeNull();
  });
});

// ── SoonPage tests ──────────────────────────────────────────────────────────

describe("SoonPage", () => {
  it("renders the Team digest placeholder page", () => {
    render(
      <MemoryRouter>
        <SoonPage />
      </MemoryRouter>
    );

    expect(screen.getByText("COMING IN V1.5")).toBeInTheDocument();
    expect(screen.getByText("Team digest")).toBeInTheDocument();
  });

  it("shows example not live data labeling", () => {
    render(
      <MemoryRouter>
        <SoonPage />
      </MemoryRouter>
    );

    expect(
      screen.getByText(/example, not live data/)
    ).toBeInTheDocument();
  });

  it("shows info banner stating nothing is live", () => {
    render(
      <MemoryRouter>
        <SoonPage />
      </MemoryRouter>
    );

    expect(
      screen.getByText(/This page is a placeholder/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nothing on it is live/)
    ).toBeInTheDocument();
  });

  it("has a link to browse real knowledge", () => {
    render(
      <MemoryRouter>
        <SoonPage />
      </MemoryRouter>
    );

    expect(
      screen.getByText("Browse knowledge")
    ).toBeInTheDocument();
  });

  it("shows ghost example rows with Decision and Gotcha badges", () => {
    render(
      <MemoryRouter>
        <SoonPage />
      </MemoryRouter>
    );

    expect(screen.getByText("Decision")).toBeInTheDocument();
    expect(screen.getByText("Gotcha")).toBeInTheDocument();
    expect(screen.getByText("Disputed")).toBeInTheDocument();

    // Counts should be present
    expect(screen.getByText("×3 this week")).toBeInTheDocument();
    expect(screen.getByText("×7 this week")).toBeInTheDocument();
    expect(screen.getByText("needs a call")).toBeInTheDocument();
  });

  it("ghost card is not clickable and does not imply live functionality", () => {
    const { container } = render(
      <MemoryRouter>
        <SoonPage />
      </MemoryRouter>
    );

    // No buttons in the ghost card
    const ghostCard = container.querySelector(".ghost-card");
    expect(ghostCard).not.toBeNull();
    expect(ghostCard?.querySelector("button")).toBeNull();
    // No links in the ghost card
    expect(ghostCard?.querySelector("a")).toBeNull();
  });
});
