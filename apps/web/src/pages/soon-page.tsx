import { SoonPlaceholder } from "@/components/ui/soon-placeholder";
import { Link } from "react-router-dom";
import { GitBranch, AlertTriangle } from "lucide-react";

/** P2 placeholder page for Team digest.
 *
 *  Red line R8: must not be clickable or imply the feature is implemented.
 *  Ghost cards show example shape with "example, not live data" labeling. */
export function SoonPage() {
  return (
    <SoonPlaceholder
      title="Team digest"
      description="A weekly brief, auto-compiled from your team's own activity: new decisions, gotchas that bit someone, and disputes that need a human call."
      versionLabel="COMING IN V1.5"
      infoBanner={
        <div className="flex flex-col gap-1">
          <div>
            This page is a placeholder — the digest isn&apos;t built yet, and
            nothing on it is live. Knowledge compiles continuously in the
            meantime.
          </div>
          <div>
            <Link to="/knowledge" className="btn btn-sm btn-outline mt-2 inline-flex">
              Browse knowledge
            </Link>
          </div>
        </div>
      }
    >
      {/* Ghost rows showing what the digest would look like */}
      <div className="g-row">
        <span className="tbadge decision">
          <GitBranch className="w-3 h-3" />
          Decision
        </span>
        <div className="skeleton flex-1 max-w-[280px] h-[10px]" />
        <span className="text-[11px] text-text-3 font-mono">×3 this week</span>
      </div>
      <div className="g-row">
        <span className="tbadge gotcha">
          <AlertTriangle className="w-3 h-3" />
          Gotcha
        </span>
        <div className="skeleton flex-1 max-w-[220px] h-[10px]" />
        <span className="text-[11px] text-text-3 font-mono">×7 this week</span>
      </div>
      <div className="g-row">
        <span className="sbadge disputed">
          <AlertTriangle className="w-3 h-3" />
          Disputed
        </span>
        <div className="skeleton flex-1 max-w-[200px] h-[10px]" />
        <span className="text-[11px] text-text-3 font-mono">needs a call</span>
      </div>
    </SoonPlaceholder>
  );
}
