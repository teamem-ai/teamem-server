/**
 * Session hook — thin bridge over the ScopeProvider from @/lib/scope.
 *
 * Every page consumes useSession() instead of calling useScope() directly
 * so that the entire app has ONE source of truth for teamId/role/projectId.
 *
 * When the scope is "loading" or "signed-out", this returns nulls — pages
 * show honest empty/permission-denied states per the design system.
 */
import { useScope } from "@/lib/scope";
import type { TeamRole } from "@teamem/schema";

export interface SessionContext {
  teamId: string | null;
  role: TeamRole | null;
  projectId: string | null;
}

/** Hook to access the current session. Returns nulls when scope is not ready
 *  — pages show honest empty/permission-denied states. */
export function useSession(): SessionContext {
  const scope = useScope();

  if (scope.status !== "ready") {
    return { teamId: null, role: null, projectId: null };
  }

  return {
    teamId: scope.teamId,
    role: scope.role as TeamRole | null,
    projectId: scope.projectId,
  };
}
