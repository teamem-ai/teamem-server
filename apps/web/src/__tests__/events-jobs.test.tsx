/**
 * Component tests for events & jobs pages (DUA-235).
 *
 * Tests cover:
 * - Events list: source badges, actor (Unknown default, webhook_verified ✓),
 *   empty state, source filtering
 * - Event detail: payload viewable, fail-closed lock state
 * - Jobs list: status badges, empty state
 * - Job detail: per-event 4-state results (compiled/skipped/failed/pending),
 *   no_llm_provider error with settings action
 * - Red lines: actor null → Unknown (not System), skipped = neutral (not error)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { EventsPage } from "@/pages/events-page";
import { EventDetailPage } from "@/pages/event-detail-page";
import { JobsPage } from "@/pages/jobs-page";
import { JobDetailPage } from "@/pages/job-detail-page";
import { AppShell } from "@/components/layout/app-shell";
import { AuditWriteFailedError } from "@/lib/api";

// ── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

function mockFetchResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function mockFetchError(error: Error) {
  mockFetch.mockRejectedValueOnce(error);
}

beforeAll(() => {
  globalThis.fetch = mockFetch as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  mockFetch.mockReset();
  cleanup();
});

// ── Render helpers ─────────────────────────────────────────────────────────

const TEST_PROJECT_ID = "prj_demo00000000000000000000";

/** Render a list page with a projectId in the URL so it doesn't block on the
 *  interim scope prompt. */
function renderListPage(
  element: React.ReactElement,
  { route = `/?projectId=${TEST_PROJECT_ID}` }: { route?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      {element}
    </MemoryRouter>,
  );
}

/** Render EventDetailPage with proper route param. */
function renderEventDetail(eventId: string, projectId = "prj_demo00000000000000000000") {
  return render(
    <MemoryRouter initialEntries={[`/events/${eventId}?projectId=${projectId}`]}>
      <Routes>
        <Route path="/events/:id" element={<EventDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Render JobDetailPage with proper route param. */
function renderJobDetail(jobId: string) {
  return render(
    <MemoryRouter initialEntries={[`/jobs/${jobId}`]}>
      <Routes>
        <Route path="/jobs/:id" element={<JobDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Mock event data ─────────────────────────────────────────────────────────

const mockEventSummary = {
  id: "evt_53014880aBcD",
  projectId: "prj_demo00000000000000000000",
  source: {
    channel: "github",
    kind: "github_commit",
    deliveryId: "abc-123",
    itemKey: "root",
    externalId: "Push to main · 3 commits",
    event: "push",
  },
  actor: {
    kind: "human" as const,
    provider: "github",
    providerUserId: "12345",
    displayLogin: "dli",
  },
  actorProvenance: "webhook_verified" as const,
  occurredAt: "2026-07-28T02:00:00.000Z",
  occurredAtProvenance: "provider" as const,
  ingestedBy: {
    credentialId: null,
    principalId: null,
  },
  payloadBytes: 1024,
  createdAt: "2026-07-28T02:00:04.000Z",
};

const mockEventNoActor = {
  ...mockEventSummary,
  id: "evt_emptyActor",
  actor: null,
  actorProvenance: "unknown" as const,
  source: {
    ...mockEventSummary.source,
    kind: "cli_init",
    externalId: "ec316e3a…:docs/runbooks/restore-postgres-from-backup.md",
  },
};

const mockEventClientClaimed = {
  ...mockEventSummary,
  id: "evt_clientClaimed",
  actor: {
    kind: "service" as const,
    provider: "custom",
    providerUserId: "svc-1",
    displayLogin: "ci-bot",
  },
  actorProvenance: "client_claimed" as const,
  source: {
    ...mockEventSummary.source,
    kind: "mcp_write",
    externalId: "Stripe webhook retries and the risk of double charges",
  },
};

const mockEventDetail = {
  ...mockEventSummary,
  payload: {
    ref: "refs/heads/main",
    after: "4f3a91c27b6d8e50a1c4f9b2e7d3a6c8b0f5e214",
    commits: [
      {
        id: "4f3a91c27b6d8e50a1c4f9b2e7d3a6c8b0f5e214",
        message: "feat: adopt pg-boss for compile queue",
        author: { name: "dli" },
      },
    ],
    repository: { full_name: "teamem-ai/teamem-server", private: true },
  },
};

const mockEmptyListResponse = {
  requestId: "req-1",
  data: [],
  nextCursor: null,
};

const mockEventListResponse = {
  requestId: "req-1",
  data: [mockEventSummary, mockEventNoActor, mockEventClientClaimed],
  nextCursor: "cursor-next",
};

const mockEventDetailResponse = {
  requestId: "req-1",
  data: mockEventDetail,
};

const mockJob = {
  id: "eaf45a04-7c3d-4a1b-9f2c-8d7e6a5b4c3d",
  projectId: "prj_demo00000000000000000000",
  status: "processing",
  attempts: 1,
  initiatedBy: { kind: "credential" as const, credentialId: "key_abc", principalId: null },
  eventCount: 4,
  events: [
    { eventId: "evt_001", status: "compiled" as const, conceptIds: ["550e8400-e29b-41d4-a716-446655440000"] },
    { eventId: "evt_002", status: "compiled" as const, conceptIds: ["550e8400-e29b-41d4-a716-446655440001"] },
    { eventId: "evt_003", status: "skipped" as const, reason: "no_knowledge" as const },
    { eventId: "evt_004", status: "pending" as const },
  ],
  createdAt: "2026-07-28T04:02:00.000Z",
  startedAt: "2026-07-28T04:02:01.000Z",
  finishedAt: undefined,
};

const mockFailedJob = {
  ...mockJob,
  id: "failed-job-uuid-000000000000000",
  status: "failed",
  error: {
    code: "no_llm_provider",
    message:
      "No LLM provider is configured, so this job could not be compiled. Set TEAMEM_ANTHROPIC_API_KEY, TEAMEM_OPENAI_API_KEY, TEAMEM_OPENROUTER_API_KEY, or the OpenAI-compatible pair, then re-submit the events.",
  },
  events: [
    { eventId: "evt_001", status: "failed" as const, error: { code: "no_llm_provider", message: "No LLM provider configured" } },
    { eventId: "evt_002", status: "failed" as const, error: { code: "no_llm_provider", message: "No LLM provider configured" } },
    { eventId: "evt_003", status: "failed" as const, error: { code: "no_llm_provider", message: "No LLM provider configured" } },
  ],
};

const mockJobsListResponse = {
  requestId: "req-1",
  data: [mockFailedJob, mockJob],
  nextCursor: "cursor-next",
};

const mockEmptyJobsResponse = {
  requestId: "req-1",
  data: [],
  nextCursor: null,
};

const mockJobDetailResponse = {
  requestId: "req-1",
  data: mockJob,
};

const mockFailedJobDetailResponse = {
  requestId: "req-1",
  data: mockFailedJob,
};

const mockJobWithAlreadyCompiled = {
  ...mockJob,
  events: [
    { eventId: "evt_001", status: "compiled" as const, conceptIds: ["550e8400-e29b-41d4-a716-446655440000"] },
    { eventId: "evt_003", status: "skipped" as const, reason: "already_compiled" as const },
  ],
  eventCount: 2,
};

const mockJobAlreadyCompiledDetailResponse = {
  requestId: "req-1",
  data: mockJobWithAlreadyCompiled,
};

// ══════════════════════════════════════════════════════════════════════════════
// Events List Page
// ══════════════════════════════════════════════════════════════════════════════

describe("EventsPage", () => {
  it("renders page heading", async () => {
    mockFetchResponse(mockEventListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText("Events")).toBeInTheDocument();
    });
  });

  it("renders events in a table with source badges", async () => {
    mockFetchResponse(mockEventListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText("Commit")).toBeInTheDocument();
      // "CLI init" appears both in filter chip and table cell — use getAllByText
      const cliElements = screen.getAllByText("CLI init");
      expect(cliElements.length).toBeGreaterThanOrEqual(2);
      const mcpElements = screen.getAllByText("MCP write");
      expect(mcpElements.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows actor display login for verified actor", async () => {
    mockFetchResponse(mockEventListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText("dli")).toBeInTheDocument();
    });
  });

  it('shows "Unknown" for null actor — never "System"', async () => {
    mockFetchResponse(mockEventListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText("Unknown")).toBeInTheDocument();
      // Must NOT show "System"
      expect(screen.queryByText("System")).toBeNull();
    });
  });

  it("shows webhook_verified checkmark for verified actors", async () => {
    mockFetchResponse(mockEventListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      // webhook_verified aria label
      const verifiedIcons = screen.getAllByLabelText("webhook_verified");
      expect(verifiedIcons.length).toBeGreaterThan(0);
    });
  });

  it("renders empty state when no events", async () => {
    mockFetchResponse(mockEmptyListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText("No events ingested yet")).toBeInTheDocument();
      expect(screen.getByText("Set up an ingestion source")).toBeInTheDocument();
    });
  });

  it("renders source filter chips", async () => {
    mockFetchResponse(mockEventListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText("All sources")).toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("CLI init")).toBeInTheDocument();
      expect(screen.getByText("MCP write")).toBeInTheDocument();
    });
  });

  it("filters GitHub events client-side because API only supports single sourceKind", async () => {
    mockFetchResponse(mockEventListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      // Full page: filter chip + table rows include CLI init
      expect(screen.getAllByText("CLI init").length).toBeGreaterThan(1);
    });
    fireEvent.click(screen.getByText("GitHub"));
    await waitFor(() => {
      // GitHub events should remain
      expect(screen.getByText("Commit")).toBeInTheDocument();
      expect(screen.getByText("dli")).toBeInTheDocument();
      // CLI init and MCP write events should be hidden; only the filter chip remains
      expect(screen.getAllByText("CLI init").length).toBe(1);
      expect(screen.getAllByText("MCP write").length).toBe(1);
      // The CLI-init row summary should not appear
      expect(
        screen.queryByText("restore-postgres-from-backup.md"),
      ).toBeNull();
    });
  });

  it("renders load more button when next cursor exists", async () => {
    mockFetchResponse(mockEventListResponse);
    renderListPage(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText("Load more")).toBeInTheDocument();
    });
  });

  it("renders non-clickable 'Soon' nav items in sidebar", async () => {
    render(
      <MemoryRouter initialEntries={[`/events?projectId=${TEST_PROJECT_ID}`]}>
        <AppShell />
      </MemoryRouter>,
    );
    await waitFor(() => {
      const soonItem = screen.getByText("Team digest").closest("div");
      expect(soonItem).toHaveAttribute("title", "Coming soon");
      expect(soonItem?.tagName).toBe("DIV");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Event Detail Page
// ══════════════════════════════════════════════════════════════════════════════

describe("EventDetailPage", () => {
  it("renders event metadata", async () => {
    mockFetchResponse(mockEventDetailResponse);
    renderEventDetail("evt_53014880aBcD");
    await waitFor(() => {
      // "Push to main · 3 commits" appears as heading AND in externalId code
      const elements = screen.getAllByText("Push to main · 3 commits");
      expect(elements.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows audit notice banner", async () => {
    mockFetchResponse(mockEventDetailResponse);
    renderEventDetail("evt_53014880aBcD");
    await waitFor(() => {
      expect(
        screen.getByText(/Payload access is recorded in the audit log/),
      ).toBeInTheDocument();
    });
  });

  it("shows payload with Copy JSON button", async () => {
    mockFetchResponse(mockEventDetailResponse);
    renderEventDetail("evt_53014880aBcD");
    await waitFor(() => {
      expect(screen.getByText("Copy JSON")).toBeInTheDocument();
    });
  });

  it("renders payload safely without HTML injection", async () => {
    const maliciousPayload = {
      ...mockEventDetailResponse,
      data: {
        ...mockEventDetail,
        payload: {
          html: "<script>alert('xss')</script>",
          nested: { value: "<img src=x onerror=alert(1)>" },
        },
      },
    };
    mockFetchResponse(maliciousPayload);
    renderEventDetail("evt_xss");
    await waitFor(() => {
      // The literal script tag should be displayed as text, not executed
      expect(screen.getByText(/<script>alert\('xss'\)<\/script>/)).toBeInTheDocument();
    });
  });

  it("shows fail-closed lock state when audit write fails", async () => {
    mockFetchError(
      new AuditWriteFailedError(500, {
        requestId: "req-audit-fail-001",
        error: {
          code: "internal",
          message: "Payload read audit failed; access denied",
        },
      }),
    );
    renderEventDetail("evt_failClosed");
    await waitFor(() => {
      // Must show the specific fail-closed lock state, NOT generic error
      expect(
        screen.getByText(/Can't display payload right now/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/reads are never allowed to bypass the audit trail/),
      ).toBeInTheDocument();
      // Must show the request ID for diagnostics
      expect(screen.getByText(/req-audit-fail-001/)).toBeInTheDocument();
      // Must show Retry button
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });

  it("shows fail-closed lock state for real backend 500 internal+audit_failed", async () => {
    // Real backend global error handler normalizes the message to
    // "Internal error" but now includes details.audit_failed = true.
    mockFetchResponse(
      {
        requestId: "req-audit-fail-002",
        error: {
          code: "internal",
          message: "Internal error",
          details: { audit_failed: true },
        },
      },
      500,
    );
    renderEventDetail("evt_realAuditFail");
    await waitFor(() => {
      // Must show the specific fail-closed lock state, NOT generic error
      expect(
        screen.getByText(/Can't display payload right now/),
      ).toBeInTheDocument();
      // Must show the request ID for diagnostics
      expect(screen.getByText(/req-audit-fail-002/)).toBeInTheDocument();
    });
  });

  it("shows actor display with webhook_verified label", async () => {
    mockFetchResponse(mockEventDetailResponse);
    renderEventDetail("evt_53014880aBcD");
    await waitFor(() => {
      expect(screen.getByText("webhook_verified")).toBeInTheDocument();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Jobs List Page
// ══════════════════════════════════════════════════════════════════════════════

describe("JobsPage", () => {
  it("renders page heading", async () => {
    mockFetchResponse(mockJobsListResponse);
    renderListPage(<JobsPage />);
    await waitFor(() => {
      expect(screen.getByText("Jobs")).toBeInTheDocument();
    });
  });

  it("renders job status badges", async () => {
    mockFetchResponse(mockJobsListResponse);
    renderListPage(<JobsPage />);
    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
      expect(screen.getByText("Processing")).toBeInTheDocument();
      // Kind column removed — the API doesn't expose job kind yet;
      // we must not fabricate a value like "compilation"
    });
  });

  it("does not fabricate a Kind column value", async () => {
    // The @teamem/schema job DTO has no `kind` field yet (DUA-156 gap).
    // We must not hardcode "compilation" as a placeholder.  The column
    // is omitted until the API exposes the real value.
    mockFetchResponse(mockJobsListResponse);
    renderListPage(<JobsPage />);
    await waitFor(() => {
      // "compilation" should not appear as a table cell value
      const cells = document.querySelectorAll("td code");
      const values = Array.from(cells).map((el) => el.textContent?.trim());
      expect(values).not.toContain("compilation");
    });
  });

  it("renders empty state when no jobs", async () => {
    mockFetchResponse(mockEmptyJobsResponse);
    renderListPage(<JobsPage />);
    await waitFor(() => {
      expect(screen.getByText("No compile jobs yet")).toBeInTheDocument();
    });
  });

  it("renders status filter chips", async () => {
    mockFetchResponse(mockJobsListResponse);
    renderListPage(<JobsPage />);
    await waitFor(() => {
      expect(screen.getByText("All")).toBeInTheDocument();
      expect(screen.getByText("Queued")).toBeInTheDocument();
      expect(screen.getByText("Completed")).toBeInTheDocument();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Job Detail Page
// ══════════════════════════════════════════════════════════════════════════════

describe("JobDetailPage", () => {
  it("renders job metadata with status pill", async () => {
    mockFetchResponse(mockJobDetailResponse);
    renderJobDetail("eaf45a04-7c3d-4a1b-9f2c-8d7e6a5b4c3d");
    await waitFor(() => {
      expect(screen.getByText("Processing")).toBeInTheDocument();
    });
  });

  it("shows per-event results with all four states", async () => {
    mockFetchResponse(mockJobDetailResponse);
    renderJobDetail("eaf45a04-7c3d-4a1b-9f2c-8d7e6a5b4c3d");
    await waitFor(() => {
      // "Compiled" appears twice — use getAllByText
      const compiledTags = screen.getAllByText("Compiled");
      expect(compiledTags.length).toBeGreaterThanOrEqual(2);
      // "Skipped" text includes " · no_knowledge", use regex
      expect(screen.getByText(/Skipped/)).toBeInTheDocument();
      expect(screen.getByText("Pending")).toBeInTheDocument();
    });
  });

  it("renders skipped with neutral styling — not error color", async () => {
    mockFetchResponse(mockJobDetailResponse);
    renderJobDetail("eaf45a04-7c3d-4a1b-9f2c-8d7e6a5b4c3d");
    await waitFor(() => {
      // The skipped tag text includes " · no_knowledge"
      const skippedTag = screen.getByText(/Skipped/);
      expect(skippedTag.classList.contains("jr-tag")).toBe(true);
      // Neutral: jr-tag skipped, not jr-tag failed
      expect(skippedTag.closest(".jr-tag.skipped")).toBeTruthy();
    });
  });

  it("shows job detail Kind placeholder instead of fabricating 'compilation'", async () => {
    mockFetchResponse(mockJobDetailResponse);
    renderJobDetail("eaf45a04-7c3d-4a1b-9f2c-8d7e6a5b4c3d");
    await waitFor(() => {
      expect(screen.getByText("Processing")).toBeInTheDocument();
    });
    // The job detail metadata must not contain a hardcoded "compilation" value.
    expect(screen.queryByText("compilation")).toBeNull();
    // It should show the honest placeholder for the missing DTO field.
    const placeholders = document.querySelectorAll(".card-head .small.muted");
    const values = Array.from(placeholders).map((el) => el.textContent?.trim());
    expect(values).toContain("—");
  });

  it("renders distinct skip reasons for no_knowledge and already_compiled", async () => {
    mockFetchResponse(mockJobAlreadyCompiledDetailResponse);
    renderJobDetail("eaf45a04-7c3d-4a1b-9f2c-8d7e6a5b4c3d");
    await waitFor(() => {
      expect(
        screen.getByText(
          /This event was already compiled into knowledge pages/,
        ),
      ).toBeInTheDocument();
    });

    // Also verify the original no_knowledge wording remains on the default mock
    cleanup();
    mockFetchResponse(mockJobDetailResponse);
    renderJobDetail("eaf45a04-7c3d-4a1b-9f2c-8d7e6a5b4c3d");
    await waitFor(() => {
      expect(
        screen.getByText(
          /No durable knowledge to keep — this is healthy filtering/,
        ),
      ).toBeInTheDocument();
    });
  });

  it("shows no_llm_provider error with settings action button", async () => {
    mockFetchResponse(mockFailedJobDetailResponse);
    renderJobDetail("failed-job-uuid-000000000000000");
    await waitFor(() => {
      expect(screen.getByText("no_llm_provider")).toBeInTheDocument();
      expect(screen.getByText("Go to LLM settings")).toBeInTheDocument();
      expect(
        screen.getByText(/Events are stored safely/),
      ).toBeInTheDocument();
    });
  });

  it("shows per-event failed results for failed jobs", async () => {
    mockFetchResponse(mockFailedJobDetailResponse);
    renderJobDetail("failed-job-uuid-000000000000000");
    await waitFor(() => {
      // Use getAllByText with a function matcher to find all elements containing "Failed"
      const failedTags = screen.getAllByText(/Failed/);
      // 1 job status + 3 per-event results = 4 "Failed" texts
      expect(failedTags.length).toBeGreaterThanOrEqual(4);
    });
  });

  it("shows pending with dashed gray styling", async () => {
    mockFetchResponse(mockJobDetailResponse);
    renderJobDetail("eaf45a04-7c3d-4a1b-9f2c-8d7e6a5b4c3d");
    await waitFor(() => {
      const pendingTag = screen.getByText("Pending");
      // "Pending" should be in a .jr-tag.pending element
      expect(pendingTag.closest(".jr-tag.pending")).toBeTruthy();
    });
  });
});
