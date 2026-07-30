import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("empty-state", className)}>
      <div className="e-icon">
        <Icon />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {actions && <div className="e-actions">{actions}</div>}
    </div>
  );
}
