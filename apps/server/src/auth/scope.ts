/**
 * Tagged ScopeContext — the authoritative scope type for every scoped
 * business query (red line 5.5).
 *
 * Two discriminators:
 * - `project` — single-project scope; carries both `teamId` and `projectId`.
 * - `allProjects` — team-wide scope; carries `teamId` only. The absence of
 *   `projectId` is the compile-time guarantee that no downstream code can
 *   accidentally treat "all projects" as a specific project.
 *
 * Construction helpers validate against @teamem/schema Zod contracts at
 * boundary input time. The tagged union is the compile-time guarantee that
 * no code path loses the team identity or conflates scope kinds.
 */
import { teamId as teamIdSchema, projectId as projectIdSchema } from '@teamem/schema';

// ── Tagged discriminated union ────────────────────────────────────────────────

interface ProjectScope {
  readonly kind: 'project';
  readonly teamId: string;
  readonly projectId: string;
}

interface AllProjectsScope {
  readonly kind: 'allProjects';
  readonly teamId: string;
  // NO projectId — deliberate. Compile-time prevention of cross-scope confusion.
}

type ScopeContext = ProjectScope | AllProjectsScope;

// ── Construction helpers (validate at boundary, return narrowed type) ──────────

function projectScope(teamId: string, projectId: string): ProjectScope {
  teamIdSchema.parse(teamId);
  projectIdSchema.parse(projectId);
  return { kind: 'project', teamId, projectId };
}

function allProjectsScope(teamId: string): AllProjectsScope {
  teamIdSchema.parse(teamId);
  return { kind: 'allProjects', teamId };
}

// ── Type narrowing ────────────────────────────────────────────────────────────

function isProjectScope(scope: ScopeContext): scope is ProjectScope {
  return scope.kind === 'project';
}

function isAllProjectsScope(scope: ScopeContext): scope is AllProjectsScope {
  return scope.kind === 'allProjects';
}

// ── Identity helpers — team identity is never lost ────────────────────────────

/**
 * Extract the teamId from any ScopeContext. Both variants carry teamId,
 * so this function never returns undefined or requires a narrowing check.
 */
function getTeamId(scope: ScopeContext): string {
  return scope.teamId;
}

/**
 * Extract the projectId — ONLY valid after narrowing to ProjectScope.
 * Accepts ProjectScope directly, or ScopeContext (but TypeScript will
 * require the caller to narrow first when used with ScopeContext).
 */
function getProjectId(scope: ProjectScope): string {
  return scope.projectId;
}

export type { ProjectScope, AllProjectsScope, ScopeContext };
export {
  projectScope,
  allProjectsScope,
  isProjectScope,
  isAllProjectsScope,
  getTeamId,
  getProjectId,
};
