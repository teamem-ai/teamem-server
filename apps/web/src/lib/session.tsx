import { createContext, useContext, type ReactNode } from "react";
import type { TeamRole } from "@teamem/schema";

/** Session data available to all pages. In production this is populated
 *  by the auth layer (M2-AUTH); until then it remains null (honest). */
export interface SessionContext {
  /** Current team ID (null when no team selected). */
  teamId: string | null;
  /** Current user's role in this team (null when anonymous). */
  role: TeamRole | null;
  /** Current project ID (null when none selected). */
  projectId: string | null;
}

const SessionCtx = createContext<SessionContext>({
  teamId: null,
  role: null,
  projectId: null,
});

/** Provider that wraps the app. Replace the default null values with
 *  real session data once M2-AUTH is wired. */
export function SessionProvider({
  value,
  children,
}: {
  value: SessionContext;
  children: ReactNode;
}) {
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

/** Hook to access the current session. Returns nulls when not authenticated
 *  — pages show honest empty/permission-denied states. */
export function useSession(): SessionContext {
  return useContext(SessionCtx);
}
