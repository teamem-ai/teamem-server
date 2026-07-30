import { cn } from "@/lib/utils";

export type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

const jobStatusConfig: Record<
  JobStatus,
  { label: string; className: string }
> = {
  queued: { label: "Queued", className: "pill" },
  processing: { label: "Processing", className: "pill blue" },
  completed: { label: "Completed", className: "pill green" },
  failed: { label: "Failed", className: "pill red" },
  cancelled: { label: "Cancelled", className: "pill" },
};

export function JobStatusPill({
  status,
  className,
}: {
  status: JobStatus;
  className?: string;
}) {
  const config = jobStatusConfig[status];
  return (
    <span className={cn(config.className, className)}>
      {status === "processing" && <span className="pulse-dot" />}
      {config.label}
    </span>
  );
}
