import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { KnowledgePage } from "@/pages/knowledge-page";
import { ScopeProvider } from "@/lib/scope";
// The vi.mock factory below makes these the MOCKED classes — constructing
// errors from them keeps `instanceof` identity consistent with the hook.
import { ApiError, AuditWriteFailedError } from "@/lib/api";

/**
 * M3-EXPORT-05 — Portal "Export OKF bundle" entry.
 *
 * Renders the REAL KnowledgePage + ScopeProvider and drives the export
 * button through the mocked @/lib/api module boundary (downloadExportFile
 * stubbed; everything else resolves exactly like the real server).
 *
 * Coverage:
 *   - member sees the entry, downloads the archive, and gets a visible
 *     success message using the SERVER-provided filename (never guessed);
 *   - non-2xx / fail-closed audit responses are surfaced as visible error
 *     feedback with a working Retry — never silently swallowed;
 *   - role-aware: viewer never sees the button (member+);
 *   - honest empty state: no project → no button, page shows its own
 *     "No project yet" state.
 */

const mocks = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  fetchProjects: vi.fn(),
  fetchConcepts: vi.fn(),
  searchConcepts: vi.fn(),
  downloadExportFile: vi.fn(),
}));

vi.mock("@/lib/api", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    details?: unknown;
    constructor(status: number, code: string, message: string, details?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }
  class MockAuditWriteFailedError extends MockApiError {
    constructor(status: number, code: string, message: string, details?: unknown) {
      super(status, code, message, details);
      this.name = "AuditWriteFailedError";
    }
  }
  return {
    fetchMe: (...args: unknown[]) => mocks.fetchMe(...args),
    fetchProjects: (...args: unknown[]) => mocks.fetchProjects(...args),
    fetchConcepts: (...args: unknown[]) => mocks.fetchConcepts(...args),
    searchConcepts: (...args: unknown[]) => mocks.searchConcepts(...args),
    downloadExportFile: (...args: unknown[]) => mocks.downloadExportFile(...args),
    ApiError: MockApiError,
    AuditWriteFailedError: MockAuditWriteFailedError,
  };
});

const MEMBER_SESSION = {
  userId: "usr_1",
  githubLogin: "dli",
  avatarUrl: null,
  teamId: "team_1",
  teamName: "Acme Corp",
  role: "member" as const,
};

const VIEWER_SESSION = { ...MEMBER_SESSION, role: "viewer" as const };

type TestSession = Omit<typeof MEMBER_SESSION, "role"> & {
  role: "owner" | "admin" | "member" | "viewer";
};

const PROJECTS = [
  { id: "prj_webapp", teamId: "team_1", name: "web-app", createdAt: "2026-07-01T00:00:00Z" },
];

function setupScope(session: TestSession = MEMBER_SESSION) {
  mocks.fetchMe.mockResolvedValue(session);
  mocks.fetchProjects.mockResolvedValue(PROJECTS);
  mocks.fetchConcepts.mockResolvedValue({
    requestId: "r",
    data: [],
    nextCursor: null,
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/knowledge"]}>
      <ScopeProvider>
        <KnowledgePage />
      </ScopeProvider>
    </MemoryRouter>,
  );
}

// jsdom has no URL.createObjectURL; stub it and spy on the download anchor.
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let anchorClickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createObjectURL = vi.fn(() => "blob:mock-export");
  revokeObjectURL = vi.fn();
  // jsdom URL lacks createObjectURL — inject, then restore after each test.
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  anchorClickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  anchorClickSpy.mockRestore();
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

describe("KnowledgePage OKF export entry (member+)", () => {
  it("member sees the button; click downloads the archive with the server filename and shows visible success", async () => {
    setupScope();
    mocks.downloadExportFile.mockResolvedValue({
      filename: "web-app-okf-0.1.tar.gz",
      blob: new Blob(["fake-gzip"]),
    });
    renderPage();

    const button = await screen.findByRole("button", { name: /Export OKF bundle/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.downloadExportFile).toHaveBeenCalledWith("prj_webapp");
    });
    // The browser download really fired, with the server's filename.
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);

    // Visible, honest success feedback (filename is server-provided).
    expect(
      await screen.findByText(/Downloaded web-app-okf-0.1.tar.gz/),
    ).toBeInTheDocument();
  });

  it("keeps the button disabled while the bundle is being prepared", async () => {
    setupScope();
    mocks.downloadExportFile.mockImplementation(() => new Promise(() => {}));
    renderPage();

    const button = await screen.findByRole("button", { name: /Export OKF bundle/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Preparing bundle/ }),
      ).toBeDisabled();
    });
  });

  it("surfaces the server's error envelope as visible feedback and Retry re-attempts", async () => {
    setupScope();
    mocks.downloadExportFile
      .mockRejectedValueOnce(
        new ApiError(403, "forbidden", "This session cannot export"),
      )
      .mockResolvedValueOnce({
        filename: "web-app-okf-0.1.tar.gz",
        blob: new Blob(["fake-gzip"]),
      });
    renderPage();

    const button = await screen.findByRole("button", { name: /Export OKF bundle/ });
    fireEvent.click(button);

    // Visible error feedback, using the server's envelope message.
    expect(
      await screen.findByText("This session cannot export"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(mocks.downloadExportFile).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText(/Downloaded web-app-okf-0.1.tar.gz/),
    ).toBeInTheDocument();
  });

  it("explains the fail-closed audit lock instead of a raw 500", async () => {
    setupScope();
    mocks.downloadExportFile.mockRejectedValue(
      new AuditWriteFailedError(500, "internal", "Export audit failed; download denied", {
        audit_failed: true,
      }),
    );
    renderPage();

    const button = await screen.findByRole("button", { name: /Export OKF bundle/ });
    fireEvent.click(button);

    expect(
      await screen.findByText(
        /blocked because the server could not record it in the audit log/,
      ),
    ).toBeInTheDocument();
  });

  it("viewer never sees the export entry (role-aware: member+)", async () => {
    setupScope(VIEWER_SESSION);
    renderPage();

    await screen.findByText("Knowledge");
    expect(
      screen.queryByRole("button", { name: /Export OKF bundle/ }),
    ).toBeNull();
    expect(mocks.downloadExportFile).not.toHaveBeenCalled();
  });

  it("no project → no export button; the page shows its honest empty state", async () => {
    mocks.fetchMe.mockResolvedValue(MEMBER_SESSION);
    mocks.fetchProjects.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("No project yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Export OKF bundle/ }),
    ).toBeNull();
    expect(mocks.downloadExportFile).not.toHaveBeenCalled();
  });
});