-- DUA-190: Add full-text search tsvector (generated from title + body).
-- Uses `simple` config to avoid hardcoding a single language; CJK and other
-- non-English text still produces usable tokens for GIN index matching.
ALTER TABLE "concepts" ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body", ''))) STORED;--> statement-breakpoint
CREATE INDEX "concepts_search_fts_gin" ON "concepts" USING gin ("search_tsv");