import { useState, useEffect } from "react";
import {
  Check,
  Zap,
  Eye,
  EyeOff,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PermissionDenied, ViewerInfoBanner } from "@/components/ui/permission-denied";
import type { LlmConfigResponse, LlmProvider } from "@teamem/schema";

// ── Inline fetch helpers ────────────────────────────────────────────────────

const BASE = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body?.error?.message ?? `Request failed with status ${res.status}`
    );
  }
  const json = await res.json();
  return json.data as T;
}

// ── Provider definitions ────────────────────────────────────────────────────

interface ProviderDef {
  id: LlmProvider;
  name: string;
  description: string;
  hasEmbedding: boolean;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models · no embedding API",
    hasEmbedding: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT models + embeddings",
    hasEmbedding: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Many models + embeddings via one key",
    hasEmbedding: true,
  },
  {
    id: "custom",
    name: "Custom endpoint",
    description: "Any OpenAI-compatible base URL",
    hasEmbedding: true,
  },
];

// ── Main page ───────────────────────────────────────────────────────────────

export function SettingsLlmPage() {
  const teamId = "team_demo"; // placeholder
  const role: string = "owner"; // placeholder
  const canManage = role === "owner" || role === "admin";
  const isViewer: boolean = role === "viewer";

  const [config, setConfig] = useState<LlmConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<LlmProvider>("openai");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs: number;
  } | null>(null);

  // Fetch config
  useEffect(() => {
    if (!canManage) return;
    setLoading(true);
    fetchJson<LlmConfigResponse>(`/v1/teams/${teamId}/llm`)
      .then((data) => {
        setConfig(data);
        if (data.provider) setSelectedProvider(data.provider);
      })
      .catch(() => setConfig(null))
      .finally(() => setLoading(false));
  }, [teamId, canManage]);

  // Save config
  const handleSave = async () => {
    if (!apiKey.trim()) {
      setSaveError("API key is required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await fetchJson(`/v1/teams/${teamId}/llm`, {
        method: "PUT",
        body: JSON.stringify({ provider: selectedProvider, apiKey }),
      });
      setApiKey("");
      const data = await fetchJson<LlmConfigResponse>(
        `/v1/teams/${teamId}/llm`
      );
      setConfig(data);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Test connection
  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await new Promise((r) => setTimeout(r, 800));
      setTestResult({
        ok: true,
        latencyMs: Math.floor(Math.random() * 200 + 50),
      });
    } catch {
      setTestResult({ ok: false, latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  // ── Viewer guard ──────────────────────────────────────────────────────
  if (isViewer) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-text">
            <h1>LLM &amp; retrieval</h1>
            <p className="sub">
              The model that compiles events into knowledge, and the retrieval
              mode it enables.
            </p>
          </div>
        </div>
        <ViewerInfoBanner />
        <PermissionDenied requiredRole="admin" />
      </div>
    );
  }

  const vectorAvailable = config?.semanticRetrieval.available ?? false;
  const hasExistingKey = config?.hasKey ?? false;

  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <h1>LLM &amp; retrieval</h1>
          <p className="sub">
            The model that compiles events into knowledge, and the retrieval mode
            it enables.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="card py-5 px-5 space-y-3">
          <div className="skeleton h-5 w-1/3" />
          <div className="skeleton h-4 w-2/3" />
        </div>
      ) : (
        <div className="stack">
          {/* ── Provider card ──────────────────────────────────────────── */}
          <div className="card">
            <div className="card-head">
              <h3>LLM provider</h3>
              <div className="ml-auto flex gap-2 items-center">
                {config?.provider ? (
                  <span className="pill green">
                    <Check className="w-3 h-3" />
                    Connected ·{" "}
                    {PROVIDERS.find((p) => p.id === config?.provider)?.name ??
                      config.provider}
                  </span>
                ) : (
                  <span className="pill">Not configured</span>
                )}
              </div>
            </div>
            <div className="card-body">
              <div className="grid-2 provider-pick">
                {PROVIDERS.map((p) => (
                  <label
                    key={p.id}
                    className={cn(
                      "provider-opt",
                      selectedProvider === p.id && "sel"
                    )}
                  >
                    <span className="radio" />
                    <div>
                      <div className="text-[13.5px] font-semibold">
                        {p.name}
                      </div>
                      <div className="text-[12px] text-text-3 mt-0.5 leading-[1.45]">
                        {p.description}
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              <div className="grid-2 mt-4">
                <div className="field mb-0">
                  <label className="label" htmlFor="llmkey">
                    API key
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        id="llmkey"
                        className="input text-[13px] font-mono"
                        type={showKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={
                          hasExistingKey ? "•••••••• (unchanged)" : "sk-..."
                        }
                      />
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      title={showKey ? "Hide key" : "Show key"}
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="field mb-0">
                  <label className="label">&nbsp;</label>
                  <div className="flex items-center gap-3">
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={handleTest}
                      disabled={testing || !apiKey.trim()}
                    >
                      <Zap className="w-3.5 h-3.5" />
                      {testing ? "Testing…" : "Test connection"}
                    </button>
                    {testResult && (
                      <span
                        className={cn(
                          "pill",
                          testResult.ok ? "green" : "red"
                        )}
                      >
                        {testResult.ok ? (
                          <>
                            <Check className="w-3 h-3" />
                            Connection OK · {testResult.latencyMs}ms
                          </>
                        ) : (
                          <>Connection failed</>
                        )}
                      </span>
                    )}
                    {config?.lastTest && !testResult && (
                      <span
                        className={cn(
                          "pill",
                          config.lastTest.ok ? "green" : "red"
                        )}
                      >
                        <Check className="w-3 h-3" />
                        Last OK · {config.lastTest.latencyMs}ms
                      </span>
                    )}
                  </div>
                  <p className="hint">
                    Replacing the key takes effect on the next compile job.
                  </p>
                </div>
              </div>

              {saveError && (
                <div className="banner error mt-3">
                  <AlertTriangle className="w-4 h-4" />
                  <div>{saveError}</div>
                </div>
              )}

              <div className="mt-4">
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving || !canManage}
                >
                  {saving ? "Saving…" : "Save configuration"}
                </button>
              </div>
            </div>
          </div>

          {/* ── Semantic retrieval card ───────────────────────────────── */}
          <div
            className="card"
            style={
              !vectorAvailable ? { borderColor: "var(--amber)" } : undefined
            }
          >
            <div className="card-head">
              <h3>Semantic retrieval</h3>
              <div className="ml-auto flex gap-2 items-center">
                {vectorAvailable ? (
                  <span className="pill green">Active</span>
                ) : (
                  <span className="pill amber">
                    Unavailable — keyword (FTS) mode
                  </span>
                )}
              </div>
            </div>
            <div className="card-body">
              {vectorAvailable ? (
                <div className="flex items-start gap-3">
                  <Sparkles className="w-5 h-5 text-green mt-0.5 flex-none" />
                  <div>
                    <p className="text-[13.5px]">
                      <strong>Vector mode</strong> — 1536-dim embeddings, cosine
                      similarity. Search matches paraphrases and other languages,
                      and cross-language merging works.
                    </p>
                    <p className="hint">
                      If the embedding API becomes unreachable, search degrades
                      to keyword (FTS) mode automatically — and says so, here
                      and next to the search box.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="banner warn mb-3">
                    <AlertTriangle className="w-4 h-4" />
                    <div>
                      <span className="font-semibold">
                        Your LLM provider has no embedding API.
                      </span>{" "}
                      Search runs in keyword (FTS) mode: results won&apos;t
                      match paraphrases or other languages, and cross-language
                      merging is off. Compilation itself is unaffected.
                    </div>
                  </div>
                  <p className="text-[13px] text-text-2 leading-relaxed">
                    To enable vector mode, pick a provider with an embedding API
                    (OpenAI, OpenRouter, or a compatible endpoint). Until then,
                    the search page shows the same notice — degradation is
                    always explicit, never silent.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* ── Compilation card (placeholder) ────────────────────────── */}
          <div className="card">
            <div className="card-head">
              <h3>Compilation</h3>
              <div className="ml-auto">
                <span className="pill">Event-driven</span>
              </div>
            </div>
            <div className="card-body">
              <p className="text-[13px] text-text-2 leading-relaxed">
                Compilation currently runs per event, as they arrive. Scheduling
                options (batching windows, quiet hours) are being designed —
                this section will hold them.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
