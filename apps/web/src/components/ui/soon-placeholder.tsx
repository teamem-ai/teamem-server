import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** Reusable "coming soon" placeholder wrapper.
 *
 *  Shared visual language for:
 *  1. Navigation items (sidebar: Team digest + SOON badge)
 *  2. Full placeholder pages (soon page)
 *  3. Disputed reconciliation entry (concept detail)
 *  4. Project settings staleness detection toggle
 *
 *  Red line R8: must not be clickable or imply the feature is implemented. */

export interface SoonPlaceholderProps {
  /** Feature title, e.g. "Team digest" */
  title: string;
  /** What this feature will do, future tense */
  description?: string;
  /** Version when this is expected, e.g. "COMING IN V1.5" */
  versionLabel?: string;
  /** Ghost example content — rendered in a dashed card with "example, not live data" */
  children?: ReactNode;
  /** Additional info banner content below the ghost card */
  infoBanner?: ReactNode;
  className?: string;
}

export function SoonPlaceholder({
  title,
  description,
  versionLabel = "COMING IN V1.5",
  children,
  infoBanner,
  className,
}: SoonPlaceholderProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center min-h-[60vh] text-center",
        className
      )}
    >
      {/* Version badge */}
      <span className="pill soon text-[11px] px-[10px] py-[5px] mb-5">
        {versionLabel}
      </span>

      {/* Title + description */}
      <h1 className="text-[24px] font-bold tracking-[-0.02em] mb-[10px]">
        {title}
      </h1>
      {description && (
        <p className="text-text-2 text-[14px] max-w-[520px] leading-relaxed mb-10">
          {description}
        </p>
      )}

      {/* Ghost example card (optional) */}
      {children && (
        <div className="ghost-card max-w-[580px] w-full text-left mb-8">
          <div className="text-[11px] font-semibold text-text-3 uppercase tracking-[0.06em] mb-[10px]">
            What it will look like — example, not live data
          </div>
          {children}
        </div>
      )}

      {/* Info banner */}
      {infoBanner && (
        <div className="banner info max-w-[580px] w-full">{infoBanner}</div>
      )}
    </div>
  );
}
