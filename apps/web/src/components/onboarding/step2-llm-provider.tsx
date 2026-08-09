/**
 * Step 2 — Connect an LLM provider.
 *
 * The selected provider is saved to the team's LLM config (PUT /v1/teams/:id/llm,
 * provider only) so it carries through to Settings → LLM and drives compilation.
 * The API key is added later in Settings (or via env). The FTS degradation
 * warning is explicit (R2) — providers without an embedding API (Anthropic)
 * result in keyword-only search.
 */
import { LLM_PROVIDERS, saveLlmProvider, ApiRequestError, type LlmProviderMeta } from "./onboarding-api";
import { AlertTriangle, Zap } from "lucide-react";
import { useState } from "react";

export interface Step2Data {
  providerKind: LlmProviderMeta["kind"];
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
  const [selected, setSelected] = useState<LlmProviderMeta["kind"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selectedMeta = selected
    ? LLM_PROVIDERS.find((p) => p.kind === selected) ?? null
    : null;

  const handleContinue = async () => {
    if (!selectedMeta) {
      // No provider selected — proceed without recording a choice.
      onComplete({
        providerKind: "claude",
        hasSemanticSearch: false,
        skipped: false,
      });
      return;
    }

    // Persist the selection so Settings → LLM reflects it and compilation
    // uses this provider (once a key is added).
    setSaving(true);
    setSaveError(null);
    try {
      await saveLlmProvider(teamId, selectedMeta.kind);
    } catch (err) {
      setSaveError(
        err instanceof ApiRequestError
          ? err.message
          : "Couldn't save your provider selection. You can set it in Settings → LLM.",
      );
      setSaving(false);
      return;
    }
    setSaving(false);
    onComplete({
      providerKind: selectedMeta.kind,
      hasSemanticSearch: selectedMeta.hasEmbedding,
      skipped: false,
    });
  };

  return (
    <div>
      <h1>Connect an LLM provider</h1>
      <p className="wiz-sub">
        Compilation runs on your own LLM account — events are distilled into
        concept pages by the model you choose. Pick a provider now; add its API
        key (and an optional model) afterwards in Settings → LLM.
      </p>

      <div className="card card-pad">
        {/* Provider selection cards */}
        <div className="provider-pick">
          {LLM_PROVIDERS.map((p) => (
            <button
              key={p.kind}
              type="button"
              className={`provider-opt${selected === p.kind ? " sel" : ""}`}
              onClick={() => setSelected(p.kind)}
            >
              <span className="radio" />
              <div>
                <div className="po-name">{p.name}</div>
                <div className="po-sub">{p.subtitle}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Semantic capability banner */}
      {selectedMeta && (
        <>
          {selectedMeta.hasEmbedding ? (
            <div className="banner success" style={{ marginTop: 14 }}>
              <Zap className="ic" />
              <div>
                <span className="b-title">
                  Semantic search available (vector).
                </span>{" "}
                {selectedMeta.name} has an embedding API — search will match
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
                providers anytime by updating the environment variables and
                restarting.
              </div>
            </div>
          )}
        </>
      )}

      {!selectedMeta && (
        <div className="banner info" style={{ marginTop: 14 }}>
          <Zap className="ic" />
          <div>
            <span className="b-title">Pick the provider you&apos;ll use.</span>{" "}
            We&apos;ll remember your choice — add the API key next in{" "}
            <strong>Settings → LLM</strong> (or set it via environment
            variables). Select a provider above to see whether semantic search
            will be available.
          </div>
        </div>
      )}

      {saveError && (
        <div className="banner error" style={{ marginTop: 14 }} role="alert">
          <AlertTriangle className="ic" />
          <div>{saveError}</div>
        </div>
      )}

      <div className="wiz-foot">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-outline"
          onClick={onSkip}
        >
          Skip for now — compilation stays paused
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleContinue}
          disabled={saving}
        >
          {saving
            ? "Saving…"
            : selectedMeta && !selectedMeta.hasEmbedding
              ? "Continue anyway"
              : "Continue"}
        </button>
      </div>
    </div>
  );
}
