import {
  TypeBadge,
  StatusBadge,
  ConfidenceMeter,
  RoleBadge,
  JobStatusPill,
  SoonBadge,
  EmptyState,
  DegradedBanner,
  Banner,
  KeyReveal,
  CommandBlock,
  EvidenceItem,
  ConceptRowSkeleton,
  DangerConfirmDialog,
} from "@/components/ui";
import { BookOpen, Search, AlertTriangle } from "lucide-react";
import { useState } from "react";

export function ComponentShowcase() {
  const [purgeOpen, setPurgeOpen] = useState(false);

  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <h1>Design system showcase</h1>
          <p className="sub">
            Compare against <code>docs/ui-design/index.html</code>. All tokens,
            badges, and global components from the design system.
          </p>
        </div>
      </div>

      {/* ========== Type Badges ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Type Badges (6)
        </h2>
        <div className="card card-pad flex flex-wrap gap-3 items-center">
          <TypeBadge type="decision" />
          <TypeBadge type="gotcha" />
          <TypeBadge type="convention" />
          <TypeBadge type="runbook" />
          <TypeBadge type="service" />
          <TypeBadge type="concept" />
        </div>
      </section>

      {/* ========== Status Badges ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Status Badges (4)
        </h2>
        <div className="card card-pad flex flex-wrap gap-4 items-center">
          <StatusBadge status="active" />
          <StatusBadge status="superseded" />
          <StatusBadge status="needs-review" />
          <StatusBadge status="disputed" />
        </div>
      </section>

      {/* ========== Confidence Meter ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Confidence (3 levels, weak visual)
        </h2>
        <div className="card card-pad flex flex-wrap gap-4 items-center">
          <ConfidenceMeter level="high" />
          <ConfidenceMeter level="medium" />
          <ConfidenceMeter level="low" />
        </div>
      </section>

      {/* ========== Role Badges ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Role Badges (4)
        </h2>
        <div className="card card-pad flex flex-wrap gap-3 items-center">
          <RoleBadge role="owner" />
          <RoleBadge role="admin" />
          <RoleBadge role="member" />
          <RoleBadge role="viewer" />
          <SoonBadge />
        </div>
      </section>

      {/* ========== Job Status Pills ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Job Status (5)
        </h2>
        <div className="card card-pad flex flex-wrap gap-3 items-center">
          <JobStatusPill status="queued" />
          <JobStatusPill status="processing" />
          <JobStatusPill status="completed" />
          <JobStatusPill status="failed" />
          <JobStatusPill status="cancelled" />
        </div>
      </section>

      {/* ========== Empty State ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Empty State (honest, no fake data)
        </h2>
        <div className="card">
          <EmptyState
            icon={BookOpen}
            title="No knowledge yet"
            description="Pages appear here once events are compiled. Connect GitHub, run teamem init, or hook up your agent via MCP."
            actions={
              <>
                <button className="btn btn-outline">Connect GitHub</button>
                <button className="btn btn-outline">Run teamem init</button>
                <button className="btn btn-outline">Hook up via MCP</button>
              </>
            }
          />
        </div>
      </section>

      {/* ========== Empty State without data ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Search empty (no results)
        </h2>
        <div className="card">
          <EmptyState
            icon={Search}
            title="No pages match your search"
            description="Try different words — semantic search understands paraphrases, so describe the problem your way."
          />
        </div>
      </section>

      {/* ========== Banners ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Banners
        </h2>
        <div className="card card-pad space-y-3">
          <DegradedBanner />
          <Banner variant="info">
            Payload access is recorded in the audit log.
          </Banner>
          <Banner variant="error">
            Can&apos;t display payload right now — audit logging is unavailable.
            Reads are blocked until it recovers.
          </Banner>
          <Banner variant="success">
            Purged: 82 events, 48 pages, 31 jobs removed. Audit trail retained.
          </Banner>
        </div>
      </section>

      {/* ========== Key Reveal ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Key Reveal (one-time display, R7)
        </h2>
        <div className="card card-pad">
          <KeyReveal token="tok_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6" />
        </div>
      </section>

      {/* ========== Command Block ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Command Block (copyable)
        </h2>
        <div className="card card-pad space-y-4">
          <CommandBlock
            command='claude mcp add teamem --config "{\"url\":\"http://localhost:3000/mcp\",\"token\":\"<paste-key>\"}"'
            description="Connect your agent to teamem via MCP"
          />
          <CommandBlock
            command="teamem init --repo=/path/to/repo"
            description="Scan a repository and push its history to the portal"
          />
        </div>
      </section>

      {/* ========== Evidence Items ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Evidence Items
        </h2>
        <div className="card card-pad space-y-2">
          <EvidenceItem
            kind="pr"
            ref="acme/web-app#214"
            time="2 hours ago"
            permalink
            href="https://github.com/acme/web-app/pull/214"
          />
          <EvidenceItem
            kind="commit"
            ref="acme/web-app@a1b2c3d"
            time="3 hours ago"
            permalink
            href="https://github.com/acme/web-app/commit/a1b2c3d"
          />
          <EvidenceItem
            kind="repo_file"
            ref="acme/web-app@a1b2c3d · src/auth/jwt.ts"
            time="5 hours ago"
            timeLabel="Snapshot"
          />
          <EvidenceItem
            kind="mcp_write"
            time="8 hours ago"
            timeLabel="Occurred"
          />
        </div>
      </section>

      {/* ========== Skeleton ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Skeleton (loading)
        </h2>
        <div className="card py-[6px] px-5">
          <ConceptRowSkeleton />
          <ConceptRowSkeleton />
          <ConceptRowSkeleton />
        </div>
      </section>

      {/* ========== 404 ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          404 (unified, no access hint)
        </h2>
        <div className="card">
          <div className="empty-state">
            <div className="e-icon">
              <AlertTriangle />
            </div>
            <h3>Not found</h3>
            <p>
              This page doesn&apos;t exist, or the link is out of date.
            </p>
          </div>
        </div>
      </section>

      {/* ========== Danger Confirm ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Danger Confirm Dialog
        </h2>
        <div className="card card-pad">
          <button
            className="btn btn-danger-outline"
            onClick={() => setPurgeOpen(true)}
          >
            Purge project data
          </button>
          <DangerConfirmDialog
            open={purgeOpen}
            onOpenChange={setPurgeOpen}
            title="Purge project data?"
            description="This permanently deletes all events, pages and jobs in web-app. Audit records are kept. Type the project name to confirm."
            confirmLabel="Purge project data"
            confirmTarget="web-app"
            level="type-name"
            onConfirm={() => console.log("purged")}
          />
        </div>
      </section>

      {/* ========== Buttons ========== */}
      <section className="mb-10">
        <h2 className="text-[13px] uppercase tracking-[0.07em] text-text-3 mb-3">
          Buttons
        </h2>
        <div className="card card-pad flex flex-wrap gap-3 items-center">
          <button className="btn btn-primary">Primary (dark)</button>
          <button className="btn btn-outline">Outline</button>
          <button className="btn btn-ghost">Ghost</button>
          <button className="btn btn-danger-outline">Danger outline</button>
          <button className="btn btn-primary" disabled>
            Disabled
          </button>
        </div>
      </section>
    </div>
  );
}
