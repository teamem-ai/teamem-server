/**
 * Interim project scope helper for M2-UI-05 until M2-AUTH-03 provides the
 * real team/project switcher scope.
 *
 * Reads projectId from the URL query string first, then localStorage.
 * Returns a small UI prompt when no projectId is configured so the page
 * honestly fails open instead of hardcoding a fake project ID and getting
 * a 404.
 */
import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";

const STORAGE_KEY = "teamem:projectId";

export interface ProjectScope {
  projectId: string | null;
  setProjectId: (id: string) => void;
  isReady: boolean;
}

export function useProjectId(): ProjectScope {
  const [searchParams, setSearchParams] = useSearchParams();
  const [isReady, setIsReady] = useState(false);

  const urlProjectId = searchParams.get("projectId");
  const [storedProjectId, setStoredProjectId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setStoredProjectId(stored);
      }
    } catch {
      // localStorage may be unavailable in some environments
    }
    setIsReady(true);
  }, []);

  const projectId = urlProjectId ?? storedProjectId;

  const setProjectId = useCallback(
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

  return { projectId, setProjectId, isReady };
}
