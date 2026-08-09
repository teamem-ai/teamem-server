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
  hasFailures = false,
}: {
  status: JobStatus;
  className?: string;
  /**
   * A "completed" job can still have failed events — compile-job.ts only
   * fails the JOB itself when EVERY event fails, so a job that's 40/58
   * failed still shows "completed" by default, which reads as a clean
   * success. When true, render a distinct amber "Completed with errors"
   * pill instead of the plain green one so a partial failure doesn't look
   * identical to a fully clean run.
   */
  hasFailures?: boolean;
}) {
  const useWarning = status === "completed" && hasFailures;
  const config = useWarning
    ? { label: "Completed with errors", className: "pill amber" }
    : jobStatusConfig[status];
  return (
    <span className={cn(config.className, className)}>
      {status === "processing" && <span className="pulse-dot" />}
      {config.label}
    </span>
  );
}
