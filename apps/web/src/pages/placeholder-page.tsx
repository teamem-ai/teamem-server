import { EmptyState } from "@/components/ui";
import { FileQuestion } from "lucide-react";
import { Link } from "react-router-dom";

/** Generic placeholder page for routes not yet implemented.
 *  Shows honest empty state — no fake data. */
export function PlaceholderPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <h1>{title}</h1>
          <p className="sub">{description}</p>
        </div>
      </div>
      <div className="card">
        <EmptyState
          icon={FileQuestion}
          title="Coming soon"
          description="This page is being built. Check back soon, or browse existing knowledge."
          actions={
            <Link to="/knowledge" className="btn btn-primary">
              Back to Knowledge
            </Link>
          }
        />
      </div>
    </div>
  );
}
