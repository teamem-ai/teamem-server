import { SoonBadge } from "@/components/ui";
import { Link } from "react-router-dom";

/** P2 placeholder page. The "Soon" visual language:
 *  dashes outlines, skeleton placeholders, "example, not live data" labeling. */
export function SoonPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <SoonBadge className="text-sm px-3 py-1.5 mb-6" />

      <h1 className="text-[22px] font-bold tracking-[-0.02em] mb-3">
        Team digest
      </h1>
      <p className="text-text-2 text-[14px] max-w-[460px] leading-relaxed mb-10">
        A weekly auto-compiled summary: new decisions, gotchas the team hit,
        and contradictions that need a human call. Coming in v1.5.
      </p>

      {/* Ghost example card */}
      <div className="card border-dashed border-border-strong max-w-[580px] w-full p-6 text-left mb-8">
        <div className="flex items-center gap-2 mb-4">
          <span className="tbadge decision">
            <svg
              className="w-3 h-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 3v12" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            Decision
          </span>
          <div className="skeleton flex-1 h-4 max-w-[280px]" />
        </div>
        <div className="skeleton h-3 w-full mb-2" />
        <div className="skeleton h-3 w-3/4 mb-4" />
        <p className="text-[11px] text-text-3 italic">
          example, not live data
        </p>
      </div>

      <div className="banner info max-w-[580px]">
        Nothing on this page is live. It shows the direction we&apos;re headed.{" "}
        <Link to="/knowledge" className="font-medium">
          Go to real knowledge →
        </Link>
      </div>
    </div>
  );
}
