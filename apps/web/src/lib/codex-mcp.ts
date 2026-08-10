/**
 * Codex (OpenAI) MCP onboarding helpers (DUA-255 / M3-DIST-02).
 *
 * Codex is a first-class MCP consumer of the same `/mcp` endpoint the web
 * app already serves — zero server changes. These helpers build the
 * pasteable `codex mcp add` command and the equivalent `~/.codex/config.toml`
 * snippet for the mint-key onboarding flow.
 *
 * Syntax was verified against `codex mcp add --help` (codex-cli): a
 * streamable-HTTP server is configured with `--url` and (optionally)
 * `--bearer-token-env-var`, which registers the NAME of an environment
 * variable Codex reads the bearer token from at runtime — it never stores
 * the token value itself. That registry entry serialises to
 * `bearer_token_env_var` in `~/.codex/config.toml`.
 *
 * SECURITY: These helpers build the *command/snippet* only. They never embed
 * the plaintext token (Codex reads it from an env var reference), so the same
 * key that `claude mcp add` embeds inline is kept out of the Codex command.
 * The one-time token is shown separately (KeyReveal) so the operator can wire
 * it into `TEAMEM_MCP_TOKEN` and it is never persisted (onboarding R7).
 */

/** The name Codex will use for this MCP server in its config. */
export const CODEX_MCP_SERVER_NAME = "teamem";

/** Env var Codex reads the bearer token from (set by the operator). */
export const CODEX_BEARER_TOKEN_ENV = "TEAMEM_MCP_TOKEN";

/** Resolve the streamable-HTTP MCP url against a base url (kept in sync
 *  with the server's `formatMcpAddCommand` → `new URL('/mcp', baseUrl)`). */
export function codexMcpUrl(baseUrl: string): string {
  return new URL("/mcp", baseUrl).toString();
}

/** Pasteable `codex mcp add` command (token NOT inline — env var reference). */
export function codexMcpAddCommand(baseUrl: string): string {
  return (
    `codex mcp add ${CODEX_MCP_SERVER_NAME} --url ${codexMcpUrl(baseUrl)} ` +
    `--bearer-token-env-var ${CODEX_BEARER_TOKEN_ENV}`
  );
}

/** Pasteable `~/.codex/config.toml` block equivalent to the command above. */
export function codexConfigTomlSnippet(baseUrl: string): string {
  return (
    `[mcp_servers.${CODEX_MCP_SERVER_NAME}]\n` +
    `url = "${codexMcpUrl(baseUrl)}"\n` +
    `bearer_token_env_var = "${CODEX_BEARER_TOKEN_ENV}"`
  );
}

/** Shell export line wiring the one-time token into the env var Codex reads.
 *  Carries the plaintext token, matching the established `claude mcp add` /
 *  `teamem init` posture: shown once, never persisted. */
export function codexTokenExportCommand(token: string): string {
  return `export ${CODEX_BEARER_TOKEN_ENV}="${token}"`;
}
