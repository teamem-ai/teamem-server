import { cn } from "@/lib/utils";
import type { PrincipalRef } from "@teamem/schema";

/**
 * Small contributor avatar stack. Shows up to `max` faces with a count badge
 * for overflow. Handles the three principal forms:
 *   - human + githubLogin + avatarUrl: bound GitHub account
 *   - human without avatar: unbound human (fallback icon)
 *   - service: service icon
 */
interface AvatarStackProps {
  contributors: PrincipalRef[];
  max?: number;
  className?: string;
}

export function AvatarStack({ contributors, max = 3, className }: AvatarStackProps) {
  const list = contributors ?? [];
  const visible = list.slice(0, max);
  const overflow = Math.max(0, list.length - max);

  return (
    <div className={cn("flex -space-x-1.5", className)} aria-label="Contributors">
      {visible.map((c) => (
        <div
          key={c.principalId}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-background bg-muted text-[10px] font-medium text-muted-foreground"
          title={c.displayName ?? c.principalId}
        >
          {c.kind === "service" ? (
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="2" y="8" width="20" height="8" rx="2" />
              <circle cx="7" cy="12" r="1" fill="currentColor" />
              <circle cx="17" cy="12" r="1" fill="currentColor" />
            </svg>
          ) : c.avatarUrl ? (
            <img
              src={c.avatarUrl}
              alt={c.displayName ?? c.principalId}
              className="h-full w-full rounded-full object-cover"
              loading="lazy"
            />
          ) : (
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" />
            </svg>
          )}
        </div>
      ))}
      {overflow > 0 && (
        <div className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-background bg-muted text-[10px] font-medium text-muted-foreground">
          +{overflow}
        </div>
      )}
    </div>
  );
}
