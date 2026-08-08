/**
 * Project scope helper for the Events / Jobs list and detail pages.
 *
 * Historically this hook trusted a projectId from the URL or its own
 * localStorage key with NO validation — so a stale id left over from a
 * previous run (or after the DB was reset) kept being sent to the API,
 * producing a 404 ("Failed to load events/jobs") even though the session had
 * a perfectly good current project. The Knowledge/Context pages never hit
 * this because they read the *validated* session scope (lib/scope.tsx).
 *
 * This hook now reconciles against that same validated scope whenever a
 * ScopeProvider is present (the entire app runs inside AppShell's provider):
 * a URL projectId is honored only if it's a project the session actually has,
 * otherwise the validated active project is used. When there is no provider
 * (isolated unit tests that render a page directly), it falls back to the
 * legacy URL/localStorage behavior so those tests keep working.
 */
import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useScopeOptional } from "./scope";

const STORAGE_KEY = "teamem:projectId";

export interface ProjectScope {
  projectId: string | null;
  setProjectId: (id: string) => void;
  isReady: boolean;
}

export function useProjectId(): ProjectScope {
  const scope = useScopeOptional();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlProjectId = searchParams.get("projectId");

  // Legacy (no-provider) state — only used by isolated tests. Hooks must run
  // unconditionally, so these are always declared even when a scope exists.
  const [storedProjectId, setStoredProjectId] = useState<string | null>(null);
  const [legacyReady, setLegacyReady] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setStoredProjectId(stored);
    } catch {
      // localStorage may be unavailable in some environments
    }
    setLegacyReady(true);
  }, []);

  const legacySetProjectId = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch {
        // ignore
      }
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("projectId", id);
        return next;
      });
    },
    [setSearchParams],
  );

  // Real app: reconcile against the validated session scope.
  if (scope) {
    const urlValid =
      urlProjectId != null && scope.projects.some((p) => p.id === urlProjectId);
    return {
      projectId: urlValid ? urlProjectId : scope.projectId,
      setProjectId: scope.setProjectId,
      isReady: scope.status !== "loading",
    };
  }

  // No ScopeProvider (isolated tests): legacy URL-then-localStorage behavior.
  return {
    projectId: urlProjectId ?? storedProjectId,
    setProjectId: legacySetProjectId,
    isReady: legacyReady,
  };
}
