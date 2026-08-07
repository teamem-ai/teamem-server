import { useState, useEffect } from "react";
import {
  Github,
  Terminal,
  Sparkles,
  Check,
  X,
  ExternalLink,
} from "lucide-react";
import { CommandBlock } from "@/components/ui/command-block";
import { PermissionDenied, ViewerInfoBanner } from "@/components/ui/permission-denied";
import type { KeyEntry, ConnectorStatusResponse, MintKeyResponse } from "@teamem/schema";
import { useSession } from "@/lib/session";

// ── Inline fetch helpers ────────────────────────────────────────────────────

const BASE = "";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE}${url}`, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed with status ${res.status}`);
  }
  const json = await res.json();
  return json.data as T;
}

// ── Main page ───────────────────────────────────────────────────────────────

export function SettingsSourcesPage() {
  const session = useSession();
  const teamId = session.teamId;
  const role = session.role ?? "viewer";
  const canManage = role === "owner" || role === "admin";
  const isViewer: boolean = role === "viewer";

  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [connectorStatus, setConnectorStatus] =
    useState<ConnectorStatusResponse | null>(null);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const [mintedMcpCommand, setMintedMcpCommand] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const effectiveProjectId = session.projectId ?? "<project-id>";

  const loadKeys = () => {
    if (!canManage) return;
    fetchJson<KeyEntry[]>(`/v1/teams/${teamId}/keys`)
      .then((data) => {
        const writeKeys = data.filter(
          (k) => !k.revoked && k.scopes.includes("events:write")
        );
        setKeys(writeKeys);
        const firstWriteKey = writeKeys[0];
        if (firstWriteKey && !selectedKeyId) setSelectedKeyId(firstWriteKey.id);
      })
      .catch(() => setKeys([]));
  };

  // Fetch available keys with write scope
  useEffect(() => {
    loadKeys();
  }, [teamId, canManage]);

  // Try to fetch connector status
  useEffect(() => {
    if (!canManage) return;
    fetchJson<ConnectorStatusResponse>(`/v1/teams/${teamId}/connectors`)
      .then(setConnectorStatus)
      .catch(() => setConnectorStatus(null));
  }, [teamId, canManage]);

  const hasWriteKey = keys.length > 0;
  const selectedKey = keys.find((k) => k.id === selectedKeyId);

  // Same-origin with the API (BASE = ""), so the browser's own address bar
  // is always the right host — no hardcoded localhost that breaks the
  // moment this is deployed behind a real domain.
  const serverBaseUrl =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:8080";

  const selectedToken = setupToken ?? (selectedKey ? "<paste-key>" : "<token>");
  const cliCommand = `teamem init --url ${serverBaseUrl} --token ${selectedToken} --project ${effectiveProjectId}`;
  const mcpCommand = mintedMcpCommand ?? `claude mcp add --transport http teamem ${serverBaseUrl}/mcp --header "Authorization: Bearer ${selectedToken}"`;

  async function handleMintSetupKey() {
    if (!canManage || !teamId) return;
    setMinting(true);
    try {
      const res = await fetch(`${BASE}/v1/teams/${teamId}/keys`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "CLI / MCP setup",
          scopes: ["events:write"],
          projectId: selectedKey?.projectId ?? session.projectId ?? null,
          allProjects: selectedKey?.allProjects ?? !session.projectId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `Mint failed: ${res.status}`);
      }
      const { data } = (await res.json()) as { data: MintKeyResponse };
      setSetupToken(data.token);
      setMintedMcpCommand(data.mcpCommand);
      loadKeys();
      // Auto-select the newly minted key
      if (data.id) setSelectedKeyId(data.id);
    } catch (e) {
      // Surface error inline would be ideal; for now keep it honest and retryable
      console.error("Failed to mint setup key", e);
    } finally {
      setMinting(false);
    }
  }

  // ── Viewer guard ──────────────────────────────────────────────────────
  if (isViewer) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>Ingestion sources</h1>
            <p className="sub">
              Where events come from. Three ways feed the compiler — use any
              combination.
            </p>
          </div>
        </div>
        <ViewerInfoBanner />
        <PermissionDenied requiredRole="admin" />
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <h1>Ingestion sources</h1>
          <p className="sub">
            Where events come from. Three ways feed the compiler — use any
            combination.
          </p>
        </div>
      </div>

      <div className="stack">
        {/* ── GitHub App card ──────────────────────────────────────── */}
        <div className="card">
          <div className="card-head">
            <span className="w-8 h-8 rounded-md bg-surface-2 border border-border flex items-center justify-center flex-none">
              <Github className="w-[18px] h-[18px]" />
            </span>
            <div>
              <h3>GitHub App</h3>
              <div className="text-[12.5px] text-text-3 font-normal mt-0.5">
                Push, PRs, issues and comments flow in via webhooks — verified by
                signature
              </div>
            </div>
            <div className="ml-auto flex gap-2 items-center">
              {connectorStatus?.github.connected ? (
                <span className="pill green">
                  <Check className="w-3 h-3" />
                  Connected
                </span>
              ) : (
                <span className="pill">Not connected</span>
              )}
            </div>
          </div>
          <div className="card-body">
            {connectorStatus?.github.connected ? (
              <>
                <dl className="kv">
                  <dt>App</dt>
                  <dd>
                    {connectorStatus.github.appName ?? "GitHub App"}{" "}
                    <span className="text-text-3 text-[12px]">
                      · the same app used for sign-in — this page manages its
                      installation scope
                    </span>
                  </dd>
                  <dt>Installed on</dt>
                  <dd>{connectorStatus.github.installedOn}</dd>
                  <dt>Repositories</dt>
                  <dd>
                    <span className="flex gap-1.5 flex-wrap">
                      {connectorStatus.github.repositories.length > 0
                        ? connectorStatus.github.repositories.map((r: string) => (
                            <code key={r} className="text-[12px] tag">
                              {r}
                            </code>
                          ))
                        : "No repositories selected — choose which ones below"}
                    </span>
                  </dd>
                  <dt>Webhook secret</dt>
                  <dd>
                    <span className="flex flex-col gap-1">
                      <span className="flex items-center gap-2">
                        {connectorStatus.github.webhookSecretConfigured ? (
                          <span className="pill green">
                            <Check className="w-3 h-3" />
                            Configured
                          </span>
                        ) : (
                          <span className="pill">Not configured</span>
                        )}
                      </span>
                      {canManage && (
                        <span className="text-[12px] text-text-3">
                          Set via <code className="mono">TEAMEM_GITHUB_WEBHOOK_SECRET</code> at
                          deploy time — there is no in-app rotation. To
                          rotate it: generate a new value, update it in both
                          your <code className="mono">.env</code> and the GitHub
                          App&apos;s Webhook settings, then restart the server.
                        </span>
                      )}
                    </span>
                  </dd>
                </dl>
                <a
                  className="btn btn-outline btn-sm mt-3.5"
                  href="https://github.com/settings/installations"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Select repositories on GitHub
                </a>
              </>
            ) : (
              <div className="text-[13.5px] text-text-2">
                <p>
                  The GitHub App provides both sign-in (OAuth) and webhook
                  ingestion. Install it on your organization to start
                  receiving events.
                </p>
                {canManage && (
                  <a
                    className="btn btn-outline btn-sm mt-3"
                    href="https://github.com/settings/apps"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Configure GitHub App
                  </a>
                )}
              </div>
            )}

            {/* Recent deliveries */}
            {connectorStatus?.github.connected &&
              connectorStatus.github.recentDeliveries.length > 0 && (
                <>
                  <hr className="divider" />
                  <div className="text-[12.5px] font-semibold mb-1">
                    Recent deliveries
                  </div>
                  {connectorStatus.github.recentDeliveries.map(
                    (d: (typeof connectorStatus.github.recentDeliveries)[number], i: number) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-[12.5px] py-[7px] border-b border-border last:border-b-0"
                    >
                      {d.success ? (
                        <Check className="w-3.5 h-3.5 text-green" />
                      ) : (
                        <X className="w-3.5 h-3.5 text-red" />
                      )}
                      <code className="text-[11.5px]">{d.event}</code>
                      <span className="text-text-3">{d.summary}</span>
                      <span className="ml-auto text-text-3">
                        {new Date(d.at).toLocaleString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </span>
                    </div>
                  ))}
                </>
              )}
          </div>
        </div>

        {/* ── CLI + MCP cards ──────────────────────────────────────── */}
        <div className="grid-2">
          {/* CLI card */}
          <div className="card">
            <div className="card-head">
              <span className="w-8 h-8 rounded-md bg-surface-2 border border-border flex items-center justify-center flex-none">
                <Terminal className="w-[18px] h-[18px]" />
              </span>
              <div>
                <h3>CLI · teamem init</h3>
                <div className="text-[12.5px] text-text-3 font-normal mt-0.5">
                  Scan an existing repo — solves cold start
                </div>
              </div>
            </div>
            <div className="card-body space-y-4">
              <div className="field mb-0">
                <label className="label">Sign the scan with key</label>
                <select
                  className="select"
                  value={selectedKeyId}
                  onChange={(e) => setSelectedKeyId(e.target.value)}
                >
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.scopes.map((s: string) => s === "events:write" ? "write" : s).join(", ")})
                    </option>
                  ))}
                  {keys.length === 0 && (
                    <option value="">No write-capable keys — mint one first</option>
                  )}
                </select>
              </div>
              {canManage && (
                <div className="flex items-center gap-2">
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={handleMintSetupKey}
                    disabled={minting}
                  >
                    {minting ? "Creating key…" : "Create write key & copy command"}
                  </button>
                </div>
              )}
              {setupToken && (
                <div className="rounded-md border border-amber-soft bg-amber-soft p-3 text-[13px] text-text-2">
                  <strong className="text-amber">One-time token:</strong>{" "}
                  <code className="font-mono text-[12px] break-all">
                    {setupToken}
                  </code>
                  <p className="mt-1 text-[12px] text-text-3">
                    Copy this now — it cannot be shown again.
                  </p>
                </div>
              )}
              <CommandBlock
                command={cliCommand}
                description="Run in your repo root:"
              />
              {connectorStatus?.cli.lastInit?.at && (
                <>
                  <hr className="divider" />
                  <div className="text-[12.5px] text-text-3">
                    Last init ·{" "}
                    {new Date(
                      connectorStatus.cli.lastInit.at
                    ).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: true,
                      timeZone: "UTC",
                    })}{" "}
                    UTC —{" "}
                    <strong className="text-text-2">
                      {connectorStatus.cli.lastInit.eventsCount} events →{" "}
                      {connectorStatus.cli.lastInit.pagesCount} pages
                    </strong>{" "}
                    · {connectorStatus.cli.lastInit.repo} @{" "}
                    {connectorStatus.cli.lastInit.commitSha?.slice(0, 7)}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* MCP card */}
          <div className="card">
            <div className="card-head">
              <span className="w-8 h-8 rounded-md bg-surface-2 border border-border flex items-center justify-center flex-none">
                <Sparkles className="w-[18px] h-[18px]" />
              </span>
              <div>
                <h3>MCP · agent writes</h3>
                <div className="text-[12.5px] text-text-3 font-normal mt-0.5">
                  Agents search pages and write events over MCP
                </div>
              </div>
            </div>
            <div className="card-body space-y-4">
              <CommandBlock
                command={mcpCommand}
                description="Connect Claude Code:"
              />
              <hr className="divider" />
              <div className="flex items-center gap-2 text-[12.5px]">
                <span className="pill green">
                  <Check className="w-3 h-3" />
                  Endpoint healthy
                </span>
                <span className="text-text-3">
                  {hasWriteKey ? (
                    <>
                      {keys.length} active key{keys.length !== 1 ? "s" : ""}{" "}
                      with <code className="text-[11px]">write</code> scope
                    </>
                  ) : (
                    "No active keys with write scope"
                  )}
                </span>
              </div>
              <p className="hint">
                Agent searches and writes via MCP are logged in the audit log,
                separately from web UI activity.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
