-- Migration 0004: llm_config table for per-team LLM provider settings (DUA-237)
CREATE TABLE IF NOT EXISTS "llm_config" (
  "team_id" TEXT NOT NULL PRIMARY KEY REFERENCES "teams"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "api_key_hash" TEXT,
  "embedding_available" BOOLEAN NOT NULL DEFAULT FALSE,
  "last_test_ok" BOOLEAN,
  "last_test_latency_ms" INTEGER,
  "last_test_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
