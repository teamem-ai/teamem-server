/**
 * Governance DTOs — team/project management and web-side key minting
 * (v0.3 additive, DUA-230).
 *
 * These DTOs serve the web UI's onboarding and settings flows:
 *   - Create a team (creator becomes owner)
 *   - Create/rename projects (admin+)
 *   - List my teams/projects (session scoped)
 *   - Web-side API key minting (admin+) with one-time plaintext token
 *     and pasteable `claude mcp add` command
 *
 * All endpoints are web-session-authenticated and derive team scope from
 * membership, NOT from client-supplied headers.
 */
import { z } from 'zod';
import { teamId, projectId, credentialId, isoDateTime } from './common.js';
import { apiScope, teamRole } from './auth.js';

// ── Team DTOs ──────────────────────────────────────────────────────────────

/** POST /v1/teams request body. */
export const createTeamRequest = z.strictObject({
  name: z.string().min(1).max(100),
});

/** POST /v1/teams response — the created team and the creator's role. */
export const createTeamResponse = z.strictObject({
  id: teamId,
  name: z.string(),
  role: teamRole,
  createdAt: isoDateTime,
});

/** A single team entry in the "my teams" list. */
export const myTeam = z.strictObject({
  id: teamId,
  name: z.string(),
  role: teamRole,
});

/** GET /v1/teams/mine response — list of teams the session user belongs to. */
export const listMyTeamsResponse = z.array(myTeam);

// ── Project DTOs ───────────────────────────────────────────────────────────

/** POST /v1/teams/:teamId/projects request body. */
export const createProjectRequest = z.strictObject({
  name: z.string().min(1).max(100),
});

/** PATCH /v1/teams/:teamId/projects/:projectId request body. */
export const renameProjectRequest = z.strictObject({
  name: z.string().min(1).max(100),
});

/** A single project entry (used in list and create/rename responses). */
export const projectEntry = z.strictObject({
  id: projectId,
  teamId,
  name: z.string(),
  createdAt: isoDateTime,
});

/** GET /v1/teams/:teamId/projects response. */
export const listProjectsResponse = z.array(projectEntry);

// ── Key Minting DTOs ───────────────────────────────────────────────────────

/**
 * POST /v1/teams/:teamId/keys request body.
 *
 * The key is bound to a project OR marked as allProjects (team-wide).
 * Scopes default to ['read'] if not specified. The N7 invariant
 * (read:payload requires read) is enforced at the database level and
 * validated at the application layer.
 */
export const mintKeyRequest = z.strictObject({
  /** Human-readable key name. */
  name: z.string().min(1).max(200),
  /**
   * Project to bind the key to. If absent and allProjects is true, the
   * key is team-wide. Mutually exclusive with allProjects.
   */
  projectId: projectId.optional(),
  /**
   * Whether this is a team-wide key. When true, projectId must NOT be
   * present. Defaults to false.
   */
  allProjects: z.boolean().optional().default(false),
  /**
   * Data-plane scopes to grant. Defaults to ['read'].
   * Never includes admin capability — API keys are data-plane only.
   */
  scopes: z.array(apiScope).min(1).max(4).optional().default(['read']),
}).refine(
  (data) => {
    // Cannot have both projectId and allProjects
    if (data.allProjects && data.projectId) {
      return false;
    }
    return true;
  },
  { message: 'allProjects keys must not specify a projectId' },
).refine(
  (data) => {
    // Normal key must have a projectId
    if (!data.allProjects && !data.projectId) {
      return false;
    }
    return true;
  },
  { message: 'a projectId is required when allProjects is false' },
);

/**
 * POST /v1/teams/:teamId/keys response.
 *
 * Contains the ONE-TIME plaintext token (never stored, never returned
 * again) and the pasteable `claude mcp add` command.
 */
export const mintKeyResponse = z.strictObject({
  /** Stable key identifier (key_...). */
  id: credentialId,
  /** Human-readable key name. */
  name: z.string(),
  /**
   * ONE-TIME plaintext API key token. Returned exactly once at mint time;
   * subsequent requests can NEVER retrieve this value.
   */
  token: z.string(),
  /**
   * Pasteable `claude mcp add` command string that registers the MCP
   * server with Claude Desktop/Code using the minted token.
   */
  mcpCommand: z.string(),
  /** The granted data-plane scopes. */
  scopes: z.array(apiScope),
  /** Whether the key is team-wide. */
  allProjects: z.boolean(),
  /** The project the key is bound to (null when allProjects). */
  projectId: projectId.nullable(),
  createdAt: isoDateTime,
});

// ── Type exports ───────────────────────────────────────────────────────────

export type CreateTeamRequest = z.infer<typeof createTeamRequest>;
export type CreateTeamResponse = z.infer<typeof createTeamResponse>;
export type MyTeam = z.infer<typeof myTeam>;
export type CreateProjectRequest = z.infer<typeof createProjectRequest>;
export type RenameProjectRequest = z.infer<typeof renameProjectRequest>;
export type ProjectEntry = z.infer<typeof projectEntry>;
export type MintKeyRequest = z.infer<typeof mintKeyRequest>;
export type MintKeyResponse = z.infer<typeof mintKeyResponse>;
