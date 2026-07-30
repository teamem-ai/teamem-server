import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export type ConceptStatus =
  | "active"
  | "superseded"
  | "disputed"
  | "needs-review";

const statusConfig: Record<
  ConceptStatus,
  { label: string; className: string }
> = {
  active: { label: "Active", className: "sbadge active" },
  superseded: { label: "Superseded", className: "sbadge superseded" },
  disputed: { label: "Disputed", className: "sbadge disputed" },
  "needs-review": { label: "Needs review", className: "sbadge needs-review" },
};

export function StatusBadge({
  status,
  className,
}: {
  status: ConceptStatus;
  className?: string;
}) {
  const config = statusConfig[status];

  if (status === "disputed") {
    return (
      <span className={cn(config.className, className)}>
        <AlertTriangle />
        {config.label}
      </span>
    );
  }

  return (
    <span className={cn(config.className, className)}>
      <span className="dot" />
      {config.label}
    </span>
  );
}
