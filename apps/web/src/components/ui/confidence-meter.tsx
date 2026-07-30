import { cn } from "@/lib/utils";

export type ConfidenceLevel = "high" | "medium" | "low";

const confidenceConfig: Record<
  ConfidenceLevel,
  { label: string; className: string }
> = {
  high: { label: "High", className: "conf-meter high" },
  medium: { label: "Medium", className: "conf-meter medium" },
  low: { label: "Low", className: "conf-meter low" },
};

export function ConfidenceMeter({
  level,
  className,
}: {
  level: ConfidenceLevel;
  className?: string;
}) {
  const config = confidenceConfig[level];

  return (
    <span className={cn(config.className, className)}>
      <span className="bars">
        <i />
        <i />
        <i />
      </span>
      <span className="clabel">{config.label}</span>
    </span>
  );
}
