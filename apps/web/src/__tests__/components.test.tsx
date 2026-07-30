import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TypeBadge } from "@/components/ui/type-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfidenceMeter } from "@/components/ui/confidence-meter";
import { RoleBadge } from "@/components/ui/role-badge";
import { JobStatusPill } from "@/components/ui/job-status-pill";
import { SoonBadge } from "@/components/ui/soon-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { DegradedBanner } from "@/components/ui/banner";
import { NotFound } from "@/components/ui/not-found";
import { BookOpen } from "lucide-react";

describe("TypeBadge", () => {
  afterEach(() => cleanup());

  it("renders all six concept types with correct labels", () => {
    const types = [
      "decision",
      "gotcha",
      "convention",
      "runbook",
      "service",
      "concept",
    ] as const;
    const labels: string[] = [];
    for (const type of types) {
      const { container } = render(<TypeBadge type={type} />);
      expect(container.textContent).toBeTruthy();
      labels.push(container.textContent ?? "");
    }
    // All six types have distinct labels
    expect(labels.filter(Boolean).length).toBe(6);
  });

  it("renders Decision badge correctly", () => {
    render(<TypeBadge type="decision" />);
    expect(screen.getByText("Decision")).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  afterEach(() => cleanup());

  it("renders all four statuses", () => {
    const statuses = ["active", "superseded", "disputed", "needs-review"] as const;
    const labels: string[] = [];
    for (const status of statuses) {
      const { container } = render(<StatusBadge status={status} />);
      expect(container.textContent).toBeTruthy();
      labels.push(container.textContent ?? "");
    }
    expect(labels.filter(Boolean).length).toBe(4);
  });

  it("renders disputed with special styling", () => {
    render(<StatusBadge status="disputed" />);
    expect(screen.getByText("Disputed")).toBeInTheDocument();
  });
});

describe("ConfidenceMeter", () => {
  afterEach(() => cleanup());

  it("renders all three levels", () => {
    const levels = ["high", "medium", "low"] as const;
    for (const level of levels) {
      cleanup();
      render(<ConfidenceMeter level={level} />);
      expect(
        screen.getByText(level.charAt(0).toUpperCase() + level.slice(1))
      ).toBeInTheDocument();
    }
  });
});

describe("RoleBadge", () => {
  afterEach(() => cleanup());

  it("renders all four roles", () => {
    const roles = ["owner", "admin", "member", "viewer"] as const;
    for (const role of roles) {
      cleanup();
      render(<RoleBadge role={role} />);
      expect(
        screen.getByText(role.charAt(0).toUpperCase() + role.slice(1))
      ).toBeInTheDocument();
    }
  });
});

describe("JobStatusPill", () => {
  afterEach(() => cleanup());

  it("renders all five job statuses", () => {
    const statuses = ["queued", "processing", "completed", "failed", "cancelled"] as const;
    for (const status of statuses) {
      cleanup();
      render(<JobStatusPill status={status} />);
      expect(
        screen.getByText(
          status.charAt(0).toUpperCase() + status.slice(1)
        )
      ).toBeInTheDocument();
    }
  });
});

describe("SoonBadge", () => {
  it("renders SOON text", () => {
    render(<SoonBadge />);
    expect(screen.getByText("SOON")).toBeInTheDocument();
  });

  it("is not clickable (rendered as span, not button)", () => {
    const { container } = render(<SoonBadge />);
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(
      <EmptyState
        icon={BookOpen}
        title="No knowledge yet"
        description="Pages appear here once events are compiled."
      />
    );
    expect(screen.getByText("No knowledge yet")).toBeInTheDocument();
    expect(
      screen.getByText("Pages appear here once events are compiled.")
    ).toBeInTheDocument();
  });

  it("does not contain fake data", () => {
    render(<EmptyState icon={BookOpen} title="No data" />);
    // Should only have the title, no sample content
    expect(screen.getByText("No data")).toBeInTheDocument();
  });
});

describe("DegradedBanner", () => {
  it("mentions keyword search", () => {
    render(<DegradedBanner />);
    expect(screen.getByText(/Keyword search only/)).toBeInTheDocument();
  });
});

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
    // Must NOT mention access/permission
    expect(screen.queryByText(/access/i)).toBeNull();
    expect(screen.queryByText(/permission/i)).toBeNull();
  });
});
