/**
 * useProjectId scope reconciliation (regression for the Events/Jobs
 * "Failed to load / Not found" 404): a stale projectId left in the URL or
 * localStorage must NOT be sent to the API when the validated session scope
 * knows the real active project.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useProjectId } from "@/lib/use-project-id";

const hoisted = vi.hoisted(() => ({ scope: null as unknown }));

vi.mock("@/lib/scope", () => ({
  useScopeOptional: () => hoisted.scope,
}));

function Probe() {
  const { projectId, isReady } = useProjectId();
  return <div data-testid="pid">{isReady ? projectId ?? "null" : "loading"}</div>;
}

function renderAt(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Probe />
    </MemoryRouter>,
  );
}

const project = (id: string) => ({ id, teamId: "team_1", name: id, createdAt: "" });

function scope(over: Record<string, unknown> = {}) {
  return {
    status: "ready",
    projects: [project("prj_real")],
    projectId: "prj_real",
    setProjectId: vi.fn(),
    ...over,
  };
}

describe("useProjectId scope reconciliation", () => {
  afterEach(() => {
    cleanup();
    hoisted.scope = null;
  });

  it("ignores a stale URL projectId and uses the validated active project", () => {
    hoisted.scope = scope();
    renderAt("/events?projectId=prj_stale_gone");
    expect(screen.getByTestId("pid").textContent).toBe("prj_real");
  });

  it("honors a URL projectId that is a real project the session has", () => {
    hoisted.scope = scope({
      projects: [project("prj_real"), project("prj_other")],
    });
    renderAt("/events?projectId=prj_other");
    expect(screen.getByTestId("pid").textContent).toBe("prj_other");
  });

  it("falls back to the active project when no projectId is in the URL", () => {
    hoisted.scope = scope();
    renderAt("/events");
    expect(screen.getByTestId("pid").textContent).toBe("prj_real");
  });

  it("uses the raw URL projectId when there is no ScopeProvider (isolated test)", async () => {
    hoisted.scope = null;
    renderAt("/events?projectId=prj_fromurl");
    await waitFor(() => {
      expect(screen.getByTestId("pid").textContent).toBe("prj_fromurl");
    });
  });
});
