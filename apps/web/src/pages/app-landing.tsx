import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getSession } from "@/lib/api";

/**
 * Post-OAuth landing page. The server redirects here after GitHub OAuth
 * completes. This component checks the session and routes the user:
 *   - Has team → /knowledge
 *   - No team  → /login?noteam=1
 *   - No session → /login
 */
export function AppLanding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const hasNoTeam = searchParams.get("no_team") === "true";
      const sess = await getSession();

      if (cancelled) return;

      if (sess && sess.teamId) {
        navigate("/knowledge", { replace: true });
      } else if (sess && !sess.teamId) {
        navigate("/login?noteam=1", { replace: true });
      } else if (hasNoTeam) {
        // Server said "no_team" but no session — likely cookie not sent.
        // Show no-team state anyway since the server knows.
        navigate("/login?noteam=1", { replace: true });
      } else {
        navigate("/login", { replace: true });
      }
    }

    void check();
    return () => { cancelled = true; };
  }, [navigate, searchParams]);

  return null;
}
