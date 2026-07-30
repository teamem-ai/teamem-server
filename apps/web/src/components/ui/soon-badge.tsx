import { cn } from "@/lib/utils";

/** "SOON" badge for placeholder features. Must not be clickable. (Red line R8) */
export function SoonBadge({ className }: { className?: string }) {
  return <span className={cn("pill soon", className)}>SOON</span>;
}
