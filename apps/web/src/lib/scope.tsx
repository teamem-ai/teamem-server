/**
 * Scope context — derives the real team/project/role from the web session.
 *
 * Data sources (all web-session authenticated, existing server endpoints):
 *   - GET /auth/me                    → user, active team, role
 *   - GET /v1/teams/:teamId/projects  → project list for the switcher
 *
 * No hardcoded project IDs or roles anywhere in the app: pages must consume
 * `useScope()` and handle every state — including "signed-out" and "error" —
 * honestly (no fake data, no pretending).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiError, fetchMe, fetchProjects, type SessionInfo } from "@/lib/api";
import type { ProjectEntry } from "@teamem/schema";

export type ScopeStatus = "loading" | "ready" | "signed-out" | "error";

export interface ScopeState {
  status: ScopeStatus;
  /** Present when status === "ready". */
  user: SessionInfo | null;
  teamId: string | null;
  teamName: string | null;
  role: SessionInfo["role"] | null;
  projects: ProjectEntry[];
  /** Active project for all scoped queries. */
  projectId: string | null;
  setProjectId: (id: string) => void;
  /** Convenience: true when the session role is viewer. */
  isViewer: boolean;
  /** Re-run the scope resolution (e.g. after sign-in). */
  reload: () => void;
  error: string | null;
}

const ScopeContext = createContext<ScopeState | null>(null);

const PROJECT_STORAGE_KEY = "teamem.activeProjectId";

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ScopeStatus>("loading");
  const [user, setUser] = useState<SessionInfo | null>(null);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [projectId, setProjectIdState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const me = await fetchMe();
      setUser(me);
      const projectList = await fetchProjects(me.teamId);
      setProjects(projectList);

      // Restore previously selected project if still present; else first.
      const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY);
      const valid = projectList.find((p) => p.id === stored);
      const active = valid ?? projectList[0] ?? null;
      setProjectIdState(active ? active.id : null);

      setStatus("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setStatus("signed-out");
      } else {
        setError(err instanceof Error ? err.message : "Failed to load scope");
        setStatus("error");
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Defense-in-depth against the browser back/forward cache (bfcache):
  // the server sends Cache-Control: no-store on the HTML shell so pages
  // should not be bfcache-eligible at all, but header behavior isn't
  // perfectly uniform across browsers/versions. If a page ever IS
  // restored from bfcache (event.persisted === true — no network request,
  // full in-memory DOM/JS state restored as-is), re-run the real /auth/me
  // check so a session that was revoked while the page was cached (e.g.
  // sign-out from another tab, or via back navigation after logout) is
  // caught immediately instead of showing stale authenticated content.
  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        void load();
      }
    }
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [load]);

  const setProjectId = useCallback((id: string) => {
    setProjectIdState(id);
    window.localStorage.setItem(PROJECT_STORAGE_KEY, id);
  }, []);

  const value = useMemo<ScopeState>(
    () => ({
      status,
      user,
      teamId: user?.teamId ?? null,
      teamName: user?.teamName ?? null,
      role: user?.role ?? null,
      projects,
      projectId,
      setProjectId,
      isViewer: user?.role === "viewer",
      reload: load,
      error,
    }),
    [status, user, projects, projectId, setProjectId, load, error],
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeState {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error("useScope must be used within a ScopeProvider");
  return ctx;
}
