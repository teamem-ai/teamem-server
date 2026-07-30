/**
 * Step 1 — Create your team & first project.
 *
 * The first user on a fresh portal creates a team (becomes owner) and
 * a first project. Everything in teamem is scoped to team → project.
 */
import { useState, type FormEvent } from "react";
import { createTeam, createProject, ApiRequestError, type CreateTeamResponse, type ProjectEntry } from "./onboarding-api";

export interface Step1Data {
  team: CreateTeamResponse | null;
  project: ProjectEntry | null;
}

export function Step1CreateTeam({
  onComplete,
}: {
  onComplete: (data: Step1Data) => void;
  onBack?: () => void;
}) {
  const [teamName, setTeamName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedTeam = teamName.trim();
    const trimmedProject = projectName.trim();

    if (!trimmedTeam) {
      setError("Team name is required.");
      return;
    }
    if (!trimmedProject) {
      setError("Project name is required.");
      return;
    }

    setSubmitting(true);
    try {
      // 1. Create the team (session user becomes owner)
      const team = await createTeam(trimmedTeam);

      // 2. Create the first project inside the team
      const project = await createProject(team.id, trimmedProject);

      onComplete({ team, project });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
      } else {
        setError(
          err instanceof Error ? err.message : "An unexpected error occurred.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h1>Create your team</h1>
      <p className="wiz-sub">
        You&apos;re the first user on this portal, so you&apos;ll become the
        team <strong>owner</strong>. Everything in teamem is scoped to a team,
        then to projects inside it.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="card card-pad">
          <div className="field">
            <label className="label" htmlFor="team-name">
              Team name
            </label>
            <input
              className="input"
              id="team-name"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="e.g. Acme Corp"
              disabled={submitting}
              autoFocus
            />
            <p className="hint">
              Usually your company or org name. You can rename it later.
            </p>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="project-name">
              First project
            </label>
            <input
              className="input"
              id="project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. web-app"
              disabled={submitting}
            />
            <p className="hint">
              A project maps to one codebase. Knowledge, events and API keys
              are scoped per project.
            </p>
          </div>
        </div>

        {error && (
          <div className="banner error" style={{ marginTop: 14 }} role="alert">
            <svg
              className="ic"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
            <div>{error}</div>
          </div>
        )}

        <div className="wiz-foot">
          <span className="spacer" />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
