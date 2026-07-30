import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton", className)} {...props} />;
}

/** Row-level skeleton for concept list loading state.
 *  Animation stops under prefers-reduced-motion. */
export function ConceptRowSkeleton() {
  return (
    <div className="flex gap-[14px] py-[15px] px-5 border-b border-border last:border-b-0">
      <div className="flex-1 min-w-0">
        <Skeleton className="h-4 w-[52%] mt-0.5" />
        <Skeleton className="h-[11px] w-[38%] mt-[10px]" />
      </div>
      <div className="flex-none">
        <Skeleton className="h-[13px] w-[44px]" />
      </div>
    </div>
  );
}
