/**
 * Shared types for the onboarding wizard.
 *
 * Mirrors @teamem/schema shapes without importing it directly
 * (the web app does not depend on the server-side schema package).
 */

export interface CreateTeamResponse {
  id: string;
  name: string;
  role: string;  // server returns the role string from DB
  createdAt: string;
}

export interface ProjectEntry {
  id: string;
  teamId: string;
  name: string;
  createdAt: string;
}

/** POST /v1/teams/:teamId/keys response shape (from governance.ts). */
export interface MintKeyResponse {
  id: string;           // key_...
  name: string;
  token: string;        // tm_... — plaintext, returned exactly once
  mcpCommand: string;   // pasteable `claude mcp add` command
  scopes: string[];
  allProjects: boolean;
  projectId: string | null;
  createdAt: string;
}
