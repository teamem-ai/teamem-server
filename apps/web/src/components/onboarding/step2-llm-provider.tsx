/**
 * Step 2 — Connect an LLM provider.
 *
 * Four provider cards let the user compare embedding capability before
 * choosing. "Test connection" gives immediate feedback. After testing,
 * a banner shows whether semantic (vector) search is available or the
 * user is in keyword-only (FTS) mode — the degradation is explicit (R2).
 *
 * The user can skip, but the skip button states the consequence clearly:
 * "compilation stays paused".
 */
import { useState, useCallback } from "react";
import {
  testLlmConnection,
  saveLlmConfig,
  ApiRequestError,
  type LlmProviderKind,
  type LlmConfigData,
  type TestConnectionResult,
} from "./onboarding-api";
import { Zap, AlertTriangle, Check } from "lucide-react";

// ── Provider metadata ──────────────────────────────────────────────────────

interface ProviderMeta {
  kind: LlmProviderKind;
  name: string;
  subtitle: string;
  hasEmbedding: boolean;
}

const providers: ProviderMeta[] = [
  {
    kind: "claude",
    name: "Anthropic",
    subtitle: "Claude models · no embedding API",
    hasEmbedding: false,
  },
  {
    kind: "openai",
    name: "OpenAI",
    subtitle: "GPT models + embeddings",
    hasEmbedding: true,
  },
  {
    kind: "openrouter",
    name: "OpenRouter",
    subtitle: "Many models + embeddings via one key",
    hasEmbedding: true,
  },
  {
    kind: "custom",
    name: "Custom endpoint",
    subtitle: "Any OpenAI-compatible base URL",
    hasEmbedding: false, // unknown until tested
  },
];

// ── Component ──────────────────────────────────────────────────────────────

export interface Step2Data {
  providerKind: LlmProviderKind;
  hasSemanticSearch: boolean;
  skipped: boolean;
}

export function Step2LlmProvider({
  teamId,
  onComplete,
  onBack,
  onSkip,
}: {
  teamId: string;
  onComplete: (data: Step2Data) => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const [selected, setSelected] = useState<LlmProviderKind | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const selectedMeta = providers.find((p) => p.kind === selected);

  const handleTest = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setTestResult(null);

    if (!apiKey.trim()) {
      setError("API key is required.");
      return;
    }

    if (selected === "custom" && !baseUrl.trim()) {
      setError("Base URL is required for custom endpoints.");
      return;
    }

    setTesting(true);
    try {
      const config: LlmConfigData = {
        kind: selected,
        apiKey: apiKey.trim(),
      };
      if (selected === "custom") {
        config.baseUrl = baseUrl.trim();
      }
      const result = await testLlmConnection(teamId, config);
      setTestResult(result);
      if (!result.ok) {
        setError(result.error ?? "Connection test failed.");
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // If the endpoint doesn't exist yet, show a clear message
        if (err.status === 404) {
          setError(
            "The LLM configuration service is not available. Your admin may need to enable it.",
          );
        } else {
          setError(err.message);
        }
      } else {
        setError(
          err instanceof Error ? err.message : "Connection test failed.",
        );
      }
    } finally {
      setTesting(false);
    }
  }, [selected, apiKey, baseUrl, teamId]);

  const handleContinue = useCallback(async () => {
    if (!selected) return;
    setError(null);

    // If the test passed and we have a key, try to save
    if (apiKey.trim() && testResult?.ok) {
      setSaving(true);
      try {
        const config: LlmConfigData = {
          kind: selected,
          apiKey: apiKey.trim(),
        };
        if (selected === "custom") {
          config.baseUrl = baseUrl.trim();
        }
        await saveLlmConfig(teamId, config);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          // Endpoint not available — proceed anyway (config via env vars)
        } else if (err instanceof ApiRequestError) {
          setError(err.message);
          setSaving(false);
          return;
        }
      } finally {
        setSaving(false);
      }
    }

    // Determine if semantic search is available
    const hasSemantic = testResult?.hasEmbedding ?? selectedMeta?.hasEmbedding ?? false;

    onComplete({
      providerKind: selected,
      hasSemanticSearch: hasSemantic,
      skipped: false,
    });
  }, [
    selected,
    apiKey,
    baseUrl,
    testResult,
    selectedMeta,
    teamId,
    onComplete,
  ]);

  const connectionOk = testResult?.ok;

  return (
    <div>
      <h1>Connect an LLM provider</h1>
      <p className="wiz-sub">
        Compilation runs on your own LLM account — events are distilled into
        concept pages by the model you choose. Your key is stored only on this
        portal.
      </p>

      <div className="card card-pad">
        {/* Provider selection cards */}
        <div className="provider-pick">
          {providers.map((p) => (
            <button
              key={p.kind}
              type="button"
              className={`provider-opt${selected === p.kind ? " sel" : ""}`}
              onClick={() => {
                setSelected(p.kind);
                setTestResult(null);
                setError(null);
              }}
            >
              <span className="radio" />
              <div>
                <div className="po-name">{p.name}</div>
                <div className="po-sub">{p.subtitle}</div>
              </div>
            </button>
          ))}
        </div>

        {/* API key field (shown when a provider is selected) */}
        {selected && (
          <>
            <div className="field" style={{ marginTop: 16 }}>
              <label className="label" htmlFor="llm-key">
                API key
              </label>
              <div style={{ position: "relative" }}>
                <input
                  className="input mono"
                  id="llm-key"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder={
                    selected === "claude"
                      ? "sk-ant-…"
                      : selected === "openai"
                        ? "sk-…"
                        : selected === "openrouter"
                          ? "sk-or-v1-…"
                          : "https://…"
                  }
                  disabled={testing || saving}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-3 hover:text-text px-2 py-1"
                  onClick={() => setShowKey(!showKey)}
                  tabIndex={-1}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
              <p className="hint">
                Sent only to your provider at compile time. Never leaves this
                portal otherwise.
              </p>
            </div>

            {/* Custom endpoint base URL */}
            {selected === "custom" && (
              <div className="field">
                <label className="label" htmlFor="llm-base-url">
                  Base URL
                </label>
                <input
                  className="input mono"
                  id="llm-base-url"
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  disabled={testing || saving}
                />
              </div>
            )}

            {/* Test connection button + result */}
            <div className="row">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={handleTest}
                disabled={testing || !apiKey.trim()}
              >
                <Zap className="ic" />
                {testing ? "Testing…" : "Test connection"}
              </button>
              {connectionOk && (
                <span className="pill green">
                  <Check className="ic" />
                  Connection OK{testResult?.latencyMs != null
                    ? ` (${testResult.latencyMs}ms)`
                    : ""}
                </span>
              )}
              {testResult && !testResult.ok && (
                <span className="pill red">
                  <AlertTriangle className="ic" />
                  Failed
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="banner error" style={{ marginTop: 14 }} role="alert">
          <AlertTriangle className="ic" />
          <div>{error}</div>
        </div>
      )}

      {/* Semantic capability banner — shown after successful test */}
      {connectionOk && selectedMeta && (
        <>
          {testResult?.hasEmbedding !== false &&
          selectedMeta.hasEmbedding ? (
            <div className="banner success" style={{ marginTop: 14 }}>
              <Zap className="ic" />
              <div>
                <span className="b-title">
                  Semantic search available (vector).
                </span>{" "}
                This provider has an embedding API — search will match
                paraphrases and other languages.
              </div>
            </div>
          ) : (
            <div className="banner warn" style={{ marginTop: 14 }} role="status">
              <AlertTriangle className="ic" />
              <div>
                <span className="b-title">Keyword search only (FTS).</span>{" "}
                {selectedMeta.name} has no embedding API, so semantic search is
                unavailable — results won&apos;t match paraphrases or other
                languages. Compilation itself works fine. You can switch
                providers anytime in{" "}
                <strong>Settings → LLM &amp; retrieval</strong>.
              </div>
            </div>
          )}
        </>
      )}

      {/* Action buttons */}
      <div className="wiz-foot">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onBack}
          disabled={testing || saving}
        >
          Back
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-outline"
          onClick={onSkip}
          disabled={testing || saving}
        >
          Skip for now — compilation stays paused
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleContinue}
          disabled={
            testing || saving || (!connectionOk && !testResult)
          }
        >
          {selectedMeta && !selectedMeta.hasEmbedding
            ? "Continue anyway"
            : saving
              ? "Saving…"
              : "Continue"}
        </button>
      </div>
    </div>
  );
}
