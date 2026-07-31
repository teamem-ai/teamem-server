import { AlertTriangle, Info, AlertCircle, CheckCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type BannerVariant = "info" | "warn" | "error" | "success";

const variantConfig: Record<
  BannerVariant,
  { icon: LucideIcon; className: string }
> = {
  info: { icon: Info, className: "banner info" },
  warn: { icon: AlertTriangle, className: "banner warn" },
  error: { icon: AlertCircle, className: "banner error" },
  success: { icon: CheckCircle, className: "banner success" },
};

export function Banner({
  variant = "info",
  title,
  children,
  actions,
  className,
  role,
}: {
  variant?: BannerVariant;
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  return (
    <div className={cn(config.className, className)} role={role}>
      <Icon className="ic" />
      <div className="flex-1 min-w-0">
        {title && <span className="b-title">{title}</span>}
        <div>{children}</div>
      </div>
      {actions && <div className="b-actions">{actions}</div>}
    </div>
  );
}

/** Pre-configured degraded-search banner (R2: must be explicit). */
export function DegradedBanner({ className }: { className?: string }) {
  return (
    <Banner variant="warn" className={className} role="status">
      <span className="b-title">Keyword search only</span> — semantic search is
      unavailable. Results won&apos;t match paraphrases or other languages.{" "}
      <a href="/settings/llm">Why?</a>
    </Banner>
  );
}
