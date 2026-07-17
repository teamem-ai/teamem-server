-- Enable pgvector for semantic retrieval (concept page embeddings).
-- Runs once on first boot of a fresh data volume; Drizzle migrations
-- also ensure the extension, covering pre-existing volumes.
CREATE EXTENSION IF NOT EXISTS vector;
