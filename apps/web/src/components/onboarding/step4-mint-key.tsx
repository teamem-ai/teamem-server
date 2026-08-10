/**
 * Step 4 — Connect your agent (mint API key + paste commands).
 *
 * Mints a real project-scoped API key via POST /v1/teams/:teamId/keys
 * (web-session-authenticated, admin+).  The plaintext token is shown
 * exactly once (R7) alongside three copyable commands.
 *
 * The server returns a pasteable `claude mcp add` command in the
 * mintKeyResponse.mcpCommand field.  We derive the `teamem init` and
 * `install-hook` commands client-side from the token.
 */
import { useState, useCallback, useEffect } from "react";
import { mintApiKey, ApiRequestError } from "./onboarding-api";
import type { MintKeyResponse } from "./onboarding-types";
import { CommandBlock } from "@/components/ui";
import {
  codexMcpAddCommand,
  codexConfigTomlSnippet,
  codexTokenExportCommand,
} from "@/lib/codex-mcp";
import { Key, AlertTriangle, Sparkles, Terminal, Zap, Bot } from "lucide-react";

export interface Step4Data {
  keyId: string;
  token: string;
  mcpCommand: string;
}

export function Step4MintKey({
  teamId,
  projectId,
  projectName,
  serverBaseUrl,
  onComplete,
  onBack,
}: {
  teamId: string;
  projectId: string;
  projectName: string;
  serverBaseUrl: string;
  onComplete: (data: Step4Data) => void;
  onBack: () => void;
}) {
  const [minted, setMinted] = useState<MintKeyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function mint() {
      setLoading(true);
      setError(null);
      try {
        const res = await mintApiKey(
          teamId,
          projectId,
          `Onboarding key for ${projectName}`,
        );
        if (!cancelled) setMinted(res.data);
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiRequestError) {
            setError(err.message);
          } else {
            setError(
              err instanceof Error
                ? err.message
                : "Failed to mint API key.",
            );
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void mint();
    return () => {
      cancelled = true;
    };
  }, [teamId, projectId, projectName]);

  const handleContinue = useCallback(() => {
    if (!minted) return;
    onComplete({
      keyId: minted.id,
      token: minted.token,
      mcpCommand: minted.mcpCommand,
    });
  }, [minted, onComplete]);

  // Derive init and install-hook commands from the minted token.
  // The mcpCommand comes from the server already formatted.
  const initCommand = minted
    ? `teamem init --url ${serverBaseUrl} --token ${minted.token} --project ${projectName}`
    : "";
  const installHookCommand = "teamem cli install-hook";

  if (loading) {
    return (
      <div>
        <h1>Connect your agent</h1>
        <p className="wiz-sub">Minting your first API key…</p>
        <div className="card card-pad">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
            <div className="skeleton" style={{ height: 32, width: "75%" }} />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1>Connect your agent</h1>
        <p className="wiz-sub">
          We couldn&apos;t mint your API key. You can try again or skip this
          step and mint keys later from Settings → API keys.
        </p>
        <div className="banner error" style={{ marginTop: 14 }} role="alert">
          <AlertTriangle className="ic" />
          <div>{error}</div>
        </div>
        <div className="wiz-foot">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Back
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              onComplete({ keyId: "", token: "", mcpCommand: "" })
            }
          >
            Skip — I&apos;ll mint keys later
          </button>
        </div>
      </div>
    );
  }

  if (!minted) return null;

  return (
    <div>
      <h1>Connect your agent</h1>
      <p className="wiz-sub">
        We minted your first API key, bound to project{" "}
        <code className="mono">{projectName}</code> with{" "}
        <code className="mono">read</code> +{" "}
        <code className="mono">write</code> scopes. Use it in the commands
        below.
      </p>

      {/* One-time key reveal */}
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="key-reveal">
          <Key
            className="ic lg"
            style={{ color: "#fbbf24", flex: "none" }}
          />
          <code>{minted.token}</code>
          <button
            className="copy-btn"
            onClick={() => {
              void navigator.clipboard.writeText(minted.token);
            }}
          >
            Copy
          </button>
        </div>
        <p
          className="text-[12.5px]"
          style={{ color: "var(--red)" }}
          role="alert"
        >
          Copy it now — you won&apos;t see this key again. We store only a
          hash.
        </p>
      </div>

      {/* Connect commands */}
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <CommandBlock
          command={minted.mcpCommand}
          description={
            <div className="cmd-label">
              <Sparkles className="ic" />
              1 · Plug team knowledge into Claude Code — your agent can search
              every page
            </div>
          }
        />

        {/* Codex — first-class MCP consumer (same /mcp endpoint, zero server
            changes). The command + config.toml reference TEAMEM_MCP_TOKEN;
            the token itself is wired in via the one-time export line. */}
        <CommandBlock
          command={codexMcpAddCommand(serverBaseUrl)}
          description={
            <div className="cmd-label">
              <Bot className="ic" />
              1b · Also plug the same knowledge into Codex — search every page
              from a Codex session
            </div>
          }
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="hint" style={{ margin: 0 }}>
            Codex reads the token from the{" "}
            <code className="mono">TEAMEM_MCP_TOKEN</code> env var. Save your
            key so Codex can read it (add this to{" "}
            <code className="mono">~/.zshrc</code> / your shell profile):
          </p>
          <CommandBlock command={codexTokenExportCommand(minted.token)} />
          <p className="hint" style={{ margin: 0 }}>
            …or paste this block into <code className="mono">~/.codex/config.toml</code>{" "}
            instead of running the command:
          </p>
          <CommandBlock command={codexConfigTomlSnippet(serverBaseUrl)} />
        </div>

        <CommandBlock
          command={initCommand}
          description={
            <div className="cmd-label">
              <Terminal className="ic" />
              2 · Scan an existing repo — seeds the knowledge base so day one
              isn&apos;t empty
            </div>
          }
        />

        <CommandBlock
          command={installHookCommand}
          description={
            <div className="cmd-label">
              <Zap className="ic" />
              3 · Auto-inject context — every new agent session starts with
              your team&apos;s top knowledge
            </div>
          }
        />
      </div>

      <div className="wiz-foot">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleContinue}
        >
          I&apos;ve copied the key — Continue
        </button>
      </div>
    </div>
  );
}
