/**
 * Step 2 — Connect an LLM provider.
 *
 * The server configures LLM providers via environment variables at deploy
 * time (TEAMEM_ANTHROPIC_API_KEY, TEAMEM_OPENAI_API_KEY, etc.) — there is
 * no web-writable LLM configuration endpoint.  This step is therefore
 * educational: it shows the four BYO provider options with their
 * embedding capabilities so the operator knows which env vars to set.
 *
 * The FTS degradation warning is explicit (R2) — providers without
 * embedding API (Anthropic) result in keyword-only search.
 */
import { LLM_PROVIDERS, type LlmProviderMeta } from "./onboarding-api";
import { AlertTriangle, Zap } from "lucide-react";
import { useState } from "react";

export interface Step2Data {
  providerKind: LlmProviderMeta["kind"];
  hasSemanticSearch: boolean;
  skipped: boolean;
}

export function Step2LlmProvider({
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

  const selectedMeta = selected
    ? LLM_PROVIDERS.find((p) => p.kind === selected) ?? null
    : null;

  const handleContinue = () => {
    if (!selectedMeta) {
      // No provider selected yet — proceed with defaults
      onComplete({
        providerKind: "claude",
        hasSemanticSearch: false,
        skipped: false,
      });
      return;
    }
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
        concept pages by the model you choose. Your key is configured at deploy
        time via environment variables and never leaves your infrastructure.
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
            <span className="b-title">LLM is configured at deploy time.</span>{" "}
            Set <code className="mono">TEAMEM_ANTHROPIC_API_KEY</code>,{" "}
            <code className="mono">TEAMEM_OPENAI_API_KEY</code>, or{" "}
            <code className="mono">TEAMEM_OPENROUTER_API_KEY</code> in your
            environment. See the deployment docs for details. Select a provider
            above to see whether semantic search will be available.
          </div>
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
        >
          {selectedMeta && !selectedMeta.hasEmbedding
            ? "Continue anyway"
            : "Continue"}
        </button>
      </div>
    </div>
  );
}
