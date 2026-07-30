/**
 * Step 4 — Connect your agent (mint API key + paste commands).
 *
 * Mints the first project-scoped API key with read+write scopes.
 * The plaintext token is shown exactly once (R7) alongside three
 * copyable commands:
 *   1. claude mcp add — registers teamem MCP with Claude
 *   2. teamem init — scans an existing repo to seed knowledge
 *   3. teamem cli install-hook — auto-injects context into new sessions
 *
 * The Continue button text reinforces the "won't see again" warning.
 */
import { useState, useCallback, useEffect } from "react";
import { mintApiKey, ApiRequestError, type MintKeyResponse } from "./onboarding-api";
import { CommandBlock } from "@/components/ui";
import { Key, AlertTriangle, Sparkles, Terminal, Zap } from "lucide-react";

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
  const [copiedKey, setCopiedKey] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function mint() {
      setLoading(true);
      setError(null);
      try {
        const result = await mintApiKey(
          teamId,
          projectId,
          `Onboarding key for ${projectName}`,
        );
        if (!cancelled) setMinted(result);
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

  // Build the init command with the token (only if we have it)
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
          <div className="space-y-3">
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-8 w-3/4" />
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
          step and mint keys later from Settings.
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
      <div className="space-y-3" style={{ marginTop: 10 }}>
        <div className="key-reveal">
          <Key
            className="ic lg"
            style={{ color: "#fbbf24", flex: "none" }}
          />
          <code>{minted.token}</code>
          <button className="copy-btn" onClick={() => {
            navigator.clipboard.writeText(minted.token);
            setCopiedKey(true);
            setTimeout(() => setCopiedKey(false), 2000);
          }}>
            {copiedKey ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="banner warn" role="alert">
          <AlertTriangle className="ic" />
          <div>
            <span className="b-title">
              Copy it now — you won&apos;t see this key again.
            </span>{" "}
            We store only a hash.
          </div>
        </div>
      </div>

      {/* Three commands */}
      <div style={{ marginTop: 20 }} className="stack">
        <CommandBlock
          command={minted.mcpCommand}
          description={
            <>
              <Sparkles className="ic" />
              1 · Plug team knowledge into Claude Code — your agent can search
              every page
            </>
          }
        />

        <CommandBlock
          command={initCommand}
          description={
            <>
              <Terminal className="ic" />
              2 · Scan an existing repo — seeds the knowledge base so day one
              isn&apos;t empty
            </>
          }
        />

        <CommandBlock
          command={installHookCommand}
          description={
            <>
              <Zap className="ic" />
              3 · Auto-inject context — every new agent session starts with
              your team&apos;s top knowledge
            </>
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
