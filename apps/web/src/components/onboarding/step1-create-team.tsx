/**
 * Step 1 — Name your team & create your first project.
 *
 * Both fields are always shown. On a fresh portal the first GitHub login has
 * already auto-bootstrapped a team (named "<login>'s Team") with the user as
 * owner — so when `existingTeam` is provided the team-name field is pre-filled
 * with that placeholder and, on submit, the existing team is *renamed* rather
 * than a second one being created (a duplicate team would give the user two
 * memberships and trip the multi-team session-scoping issue). When there is no
 * team yet, a new one is created. Either way the user names their team and
 * creates a first project in one step.
 */
import { useState, type FormEvent } from "react";
import {
  createTeam,
  createProject,
  renameTeam,
  ApiRequestError,
} from "./onboarding-api";
import type { CreateTeamResponse, ProjectEntry } from "./onboarding-types";

export interface Step1Data {
  team: CreateTeamResponse | null;
  project: ProjectEntry | null;
}

/** A team the session already belongs to (see existingTeam prop doc below). */
export interface ExistingTeam {
  id: string;
  name: string;
  role: string;
}

export function Step1CreateTeam({
  existingTeam,
  onComplete,
}: {
  /**
   * The team the session already owns (auto-bootstrapped at first GitHub
   * login). When present, step 1 pre-fills its name and renames it on submit
   * instead of creating a duplicate. When absent, a new team is created.
   */
  existingTeam?: ExistingTeam | null;
  onComplete: (data: Step1Data) => void;
  onBack?: () => void;
}) {
  const [teamName, setTeamName] = useState(existingTeam?.name ?? "");
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
      let team: CreateTeamResponse;
      if (existingTeam) {
        // Reuse the auto-bootstrapped team; rename it only if the user
        // actually changed the placeholder name.
        if (trimmedTeam !== existingTeam.name) {
          await renameTeam(existingTeam.id, trimmedTeam);
        }
        team = {
          id: existingTeam.id,
          name: trimmedTeam,
          role: existingTeam.role,
          createdAt: new Date().toISOString(),
        };
      } else {
        // No team yet — create one (session user becomes owner).
        const teamRes = await createTeam(trimmedTeam);
        team = teamRes.data;
      }

      // Create the first project inside the team.
      const projectRes = await createProject(team.id, trimmedProject);
      const project = projectRes.data;

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
      <h1>Name your team &amp; first project</h1>
      <p className="wiz-sub">
        {existingTeam ? (
          <>
            You&apos;re the <strong>owner</strong> of this portal. Give your
            team a name and add your first project — everything in teamem is
            scoped to a team, then to projects inside it.
          </>
        ) : (
          <>
            You&apos;re the first user on this portal, so you&apos;ll become
            the team <strong>owner</strong>. Everything in teamem is scoped to
            a team, then to projects inside it.
          </>
        )}
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
