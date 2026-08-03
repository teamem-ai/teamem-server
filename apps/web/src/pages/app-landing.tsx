import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getSession, fetchProjects } from "@/lib/api";

const INVITE_TOKEN_KEY = "teamem_invite_token";

/**
 * Post-OAuth landing page. The server redirects here after GitHub OAuth
 * completes. This component checks the session and routes the user:
 *   - Has stored invite token       → /join?token=... (recover guest invite)
 *   - Team + at least one project   → /knowledge (onboarding already done)
 *   - Team + no project yet         → /onboarding (finish setup — the common
 *                                      first-login case, since OAuth auto-
 *                                      bootstraps the team but not a project)
 *   - Session but no team           → /onboarding
 *   - No session                    → /onboarding (its sign-in step)
 */
export function AppLanding() {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Check for a persisted invite token first — this recovers the
      // "guest opens invite link → signs in with GitHub → accepts invite"
      // flow that would otherwise be broken (the OAuth callback at /app
      // has no way to carry the token).
      let inviteToken: string | null = null;
      try {
        inviteToken = sessionStorage.getItem(INVITE_TOKEN_KEY);
        if (inviteToken) {
          sessionStorage.removeItem(INVITE_TOKEN_KEY);
        }
      } catch { /* storage unavailable */ }

      if (inviteToken) {
        if (cancelled) return;
        navigate(`/join?token=${encodeURIComponent(inviteToken)}`, {
          replace: true,
        });
        return;
      }

      const sess = await getSession();
      if (cancelled) return;

      if (sess && sess.teamId) {
        // Onboarded only if a project exists; otherwise send them into the
        // wizard to create their first one (the usual first-login state).
        let hasProject = false;
        try {
          const projects = await fetchProjects(sess.teamId);
          hasProject = projects.length > 0;
        } catch {
          hasProject = false;
        }
        if (cancelled) return;
        navigate(hasProject ? "/knowledge" : "/onboarding", { replace: true });
      } else {
        // No session, or signed in without a team — the onboarding front
        // door handles both (sign-in step, or full from-scratch flow).
        navigate("/onboarding", { replace: true });
      }
    }

    void check();
    return () => { cancelled = true; };
  }, [navigate]);

  return null;
}
