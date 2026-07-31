import { useState } from "react";
import { Box } from "lucide-react";
import { EmptyState } from "./empty-state";

export function ProjectScopePrompt({
  onSet,
}: {
  onSet: (id: string) => void;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) {
      onSet(trimmed);
    }
  };

  return (
    <EmptyState
      icon={Box}
      title="Project scope required"
      description="Enter a project ID to load real events and jobs. This interim prompt will be replaced by the team/project switcher once M2-AUTH-03 is wired up."
      actions={
        <form onSubmit={handleSubmit} className="flex gap-2 flex-wrap justify-center">
          <input
            className="input mono"
            placeholder="prj_..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{ minWidth: 220 }}
          />
          <button type="submit" className="btn btn-primary">
            Set project
          </button>
        </form>
      }
    />
  );
}
