/**
 * Unit tests for the Codex MCP onboarding helpers (DUA-255 / M3-DIST-02).
 *
 * Pins the exact, verified `codex mcp add` syntax (`--url` + `--bearer-token-
 * env-var`) and the equivalent `~/.codex/config.toml` block, plus the security
 * invariant that the plaintext token is never embedded in the Codex command
 * (it is referenced by env-var name and wired in separately).
 */
import { describe, it, expect } from "vitest";
import {
  codexMcpUrl,
  codexMcpAddCommand,
  codexConfigTomlSnippet,
  codexTokenExportCommand,
  CODEX_MCP_SERVER_NAME,
  CODEX_BEARER_TOKEN_ENV,
} from "./codex-mcp";

const BASE_URL = "https://portal.example.com";

describe("codexMcpUrl", () => {
  it("resolves /mcp against the base url", () => {
    expect(codexMcpUrl(BASE_URL)).toBe("https://portal.example.com/mcp");
    expect(codexMcpUrl("http://localhost:8080")).toBe("http://localhost:8080/mcp");
  });
});

describe("codexMcpAddCommand", () => {
  it("uses the verified streamable-HTTP + bearer-token-env-var form", () => {
    expect(codexMcpAddCommand(BASE_URL)).toBe(
      `codex mcp add ${CODEX_MCP_SERVER_NAME} --url https://portal.example.com/mcp ` +
        `--bearer-token-env-var ${CODEX_BEARER_TOKEN_ENV}`,
    );
  });

  it("never embeds the plaintext token in the command", () => {
    const command = codexMcpAddCommand(BASE_URL);
    expect(command).not.toMatch(/tok_|tm_/);
    expect(command).not.toContain("Bearer");
  });
});

describe("codexConfigTomlSnippet", () => {
  it("produces the pasteable [mcp_servers.teamem] block", () => {
    expect(codexConfigTomlSnippet(BASE_URL)).toBe(
      `[mcp_servers.${CODEX_MCP_SERVER_NAME}]\n` +
        `url = "https://portal.example.com/mcp"\n` +
        `bearer_token_env_var = "${CODEX_BEARER_TOKEN_ENV}"`,
    );
  });
});

describe("codexTokenExportCommand", () => {
  it("carries the one-time token into the env var Codex reads", () => {
    expect(codexTokenExportCommand("tok_abc123")).toBe(
      `export ${CODEX_BEARER_TOKEN_ENV}="tok_abc123"`,
    );
  });
});