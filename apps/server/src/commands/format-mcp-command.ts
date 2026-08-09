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
  /**
   * The public URL this instance is reached at — TEAMEM_BASE_URL, or the
   * http://localhost:<port> default when unset. Deliberately the SAME value
   * GitHub OAuth's redirect_uri is built from (config/env.ts `baseUrl`), so
   * this command and the sign-in flow can never disagree about what
   * "this server" is reachable at.
   */
  readonly baseUrl: string;
}

/**
 * Build the `claude mcp add` command string.
 *
 * Resolves `/mcp` against `config.baseUrl` with the platform `URL` type
 * rather than string-concatenating protocol/host/port by hand, so it
 * correctly carries whatever scheme, host, and port (or lack of a port, for
 * a reverse proxy on 443/80) the operator configured.
 */
export function formatMcpAddCommand(
  config: McpCommandConfig,
  token: string,
): string {
  const mcpUrl = new URL('/mcp', config.baseUrl).toString();
  return `claude mcp add --transport http teamem ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}
