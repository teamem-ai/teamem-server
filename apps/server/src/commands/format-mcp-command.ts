/**
 * MCP `claude mcp add` command formatter (DUA-211 / M1-MCP-06).
 *
 * Generates a pasteable single-line shell command so operators can register
 * the teamem MCP server with Claude Desktop or Claude Code immediately after
 * minting or rotating an API key.
 *
 * SECURITY: The returned string contains the plaintext Bearer token.  The
 * caller must print it exactly once and NEVER log, store, or include it in
 * error messages, audit records, or any persistent output.
 */

export interface McpCommandConfig {
  /** Server bind host (e.g. "0.0.0.0" or "example.com"). */
  readonly host: string;
  /** Server port (e.g. 8080). */
  readonly port: number;
}

/**
 * Build the `claude mcp add` command string.
 *
 * - `0.0.0.0` is displayed as `localhost` for copy-paste friendliness.
 * - The URL uses `http` by default (self-hosted deployment).  Operators who
 *   terminate TLS at a reverse proxy should configure `TEAMEM_HOST` to their
 *   public domain name.
 */
export function formatMcpAddCommand(
  config: McpCommandConfig,
  token: string,
): string {
  const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  return `claude mcp add --transport http teamem http://${displayHost}:${config.port}/mcp --header "Authorization: Bearer ${token}"`;
}
