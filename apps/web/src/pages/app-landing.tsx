import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getSession } from "@/lib/api";

const INVITE_TOKEN_KEY = "teamem_invite_token";

/**
 * Post-OAuth landing page. The server redirects here after GitHub OAuth
 * completes. This component checks the session and routes the user:
 *   - Has stored invite token → /join?token=... (recover guest invite flow)
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

      const hasNoTeam = searchParams.get("no_team") === "true";
      const sess = await getSession();

      if (cancelled) return;

      if (sess && sess.teamId) {
        navigate("/knowledge", { replace: true });
      } else if (sess && !sess.teamId) {
        navigate("/login?noteam=1", { replace: true });
      } else if (hasNoTeam) {
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
