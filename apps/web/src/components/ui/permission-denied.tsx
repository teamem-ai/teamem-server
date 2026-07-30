import { ShieldAlert } from "lucide-react";
import { Banner } from "./banner";

/** Permission-denied guidance. Used for viewer hitting member+ features.
 *  Differs from 404: this IS about permissions (within-team feature gating). */
export function PermissionDenied({
  requiredRole = "member",
}: {
  requiredRole?: string;
}) {
  return (
    <div className="empty-state py-16">
      <div className="e-icon">
        <ShieldAlert />
      </div>
      <h3>Higher role required</h3>
      <p>
        You need at least the <strong>{requiredRole}</strong> role for this.
        Ask a team admin to update your role.
      </p>
    </div>
  );
}

/** Information banner for viewer browsing knowledge. */
export function ViewerInfoBanner() {
  return (
    <Banner variant="info">
      You&apos;re browsing as a <span className="role-badge viewer mx-1">Viewer</span> —
      semantic search needs a higher role. Ask a team admin.
    </Banner>
  );
}
