import { type LucideIcon } from "lucide-react";
import {
  GitBranch,
  AlertTriangle,
  Scroll,
  ListChecks,
  Server,
  Lightbulb,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ConceptType =
  | "decision"
  | "gotcha"
  | "convention"
  | "runbook"
  | "service"
  | "concept";

const typeConfig: Record<
  ConceptType,
  { label: string; icon: LucideIcon; className: string }
> = {
  decision: {
    label: "Decision",
    icon: GitBranch,
    className: "tbadge decision",
  },
  gotcha: {
    label: "Gotcha",
    icon: AlertTriangle,
    className: "tbadge gotcha",
  },
  convention: {
    label: "Convention",
    icon: Scroll,
    className: "tbadge convention",
  },
  runbook: {
    label: "Runbook",
    icon: ListChecks,
    className: "tbadge runbook",
  },
  service: {
    label: "Service",
    icon: Server,
    className: "tbadge service",
  },
  concept: {
    label: "Concept",
    icon: Lightbulb,
    className: "tbadge concept",
  },
};

export function TypeBadge({
  type,
  className,
}: {
  type: ConceptType;
  className?: string;
}) {
  const config = typeConfig[type];
  const Icon = config.icon;
  return (
    <span className={cn(config.className, className)}>
      <Icon />
      {config.label}
    </span>
  );
}
