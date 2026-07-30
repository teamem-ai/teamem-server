import { FileQuestion } from "lucide-react";
import { Link } from "react-router-dom";

/** Unified 404 page. Red line R3: must not distinguish "not found" from "no access".
 *  Text per GLOSSARY §6.5: "Not found. This page doesn't exist, or the link is out of date." */
export function NotFound() {
  return (
    <div className="empty-state py-24">
      <div className="e-icon">
        <FileQuestion />
      </div>
      <h3>Not found</h3>
      <p>
        This page doesn&apos;t exist, or the link is out of date.
      </p>
      <div className="e-actions">
        <Link to="/knowledge" className="btn btn-primary">
          Back to Knowledge
        </Link>
      </div>
    </div>
  );
}
