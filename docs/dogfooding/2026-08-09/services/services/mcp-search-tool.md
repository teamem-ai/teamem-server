---
type: service
uuid: 2a4f45b1-21e5-4d7b-8e12-d995ba1673f3
path: services/mcp-search-tool
status: active
confidence: high
title: MCP Search Tool Implementation & Recall Candidates Service
tags:
  - mcp
  - search
  - postgresql
  - fts
  - audit
  - recallCandidates
  - embedding
  - service
  - pgvector
  - database
  - semantics
  - query
  - repository
  - full-text search
  - decision
  - semantic
  - capability
  - hybrid
lastConfirmed: 2026-07-22T07:32:09.000Z
firstSeen: 2026-07-22T07:32:09.000Z
createdAt: 2026-08-09T13:23:54.425Z
schemaVersion: 1
supersedes: null
aliases: []
contributors:
  - principalId: pri_ba9c762aa52f48649856575c4fbb5ff2
    kind: service
    provider: teamem
    displayName: dogfood-cli
evidence:
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: f1de8b2c0b58414f0ea3337511d67e76f5c77274
    path: prs/85.md
    at: 2026-07-22T07:32:09.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: e34045c146ebf2fd519002a36c1b3f14d58c2b32
    path: prs/89.md
    at: 2026-07-23T03:30:05.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: bc8865a1dd36d581953b3a7be2b4ea1f78d03f21
    path: prs/88.md
    at: 2026-07-23T01:28:39.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 233119c7c9e7e7209c69bc058da367f05fd655cc
    path: prs/75.md
    at: 2026-07-21T23:31:11.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 10aa1d1d548116634a9e6aef3640887810291d1e
    path: prs/77.md
    at: 2026-07-22T05:21:43.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 04eec86b86212677e8aebbaa239e673f586795cf
    path: prs/91.md
    at: 2026-07-23T03:38:44.000Z
---
# MCP Search Tool Implementation & Recall Candidates Service

The MCP `search` tool provides a scoped full-text search against `concepts.search_tsv` using PostgreSQL's `websearch_to_tsquery`. It returns compact index rows including UUID, title, type, and relevance score while implementing strict audit trails and scope enforcement. This tool operates under Progressive Disclosure L1 specifications outlined in DUA-207.

## Features:
- Implements PostgreSQL FTS via `websearch_to_tsquery`, ensuring efficient search functionality.
- Returns search results with `degraded: true` indicators to denote explicit degradation in performance, accompanied by `ftsFallback: true` for fallback cases.
- Enforces project scope, allowing only project-scoped keys to access relevant data, while cross-team queries return empty sets.
- Audit records are generated for every invocation, thereby enhancing accountability and monitoring capabilities.

## Hybrid Search System
The **Hybrid Search System** combines pgvector cosine-similarity candidate recall and PostgreSQL full-text search (FTS) to deliver a single relevance-ranked and deduplicated result set. It operates in two modes: vector mode, which primarily uses vector recall and supplements with FTS, and FTS-only mode, which uses fallback markers for degraded responses. The system is housed within `hybrid.ts`, orchestrating the two recall methods and implementing pagination logic to manage the results effectively. This system aims to enhance search capabilities across various scopes and contexts within the application architecture.

## Full-Text Search Configuration Decision
The decision was made to use the `simple` text-search configuration in PostgreSQL for the `search_tsv` tsvector column and its GIN index in the concepts table. This choice was made to ensure that CJK (Chinese, Japanese, Korean) and other non-English text is preserved, avoiding the problem of hardcoding English-only stemming logic. This approach effectively supports multilingual content handling, aligning with the requirements of the project (DUA-190).

## Decision to Implement Semantic Capability Detection and FTS Graceful Degradation
We introduced `resolveSemanticCapability()` as the core function to determine if the deployment can perform semantic vector search or fallback to full-text search (FTS). This decision aims to centralize the logic for detecting semantic capability based on the presence of a non-null `EmbeddingClient`. If the `EmbeddingClient` is present, the mode is set to 'vector'; if it is null, the mode is set to 'fts-only'. Furthermore, we incorporated an optional logging callback for observability purposes to track when degradation occurs. This approach improves clarity in the code and creates a single responsible point for capability determination.

### Key Points:
- **Functionality:** `resolveSemanticCapability()` takes an `EmbeddingClient` and returns an object indicating the search mode.
- **Observability:** The logging callback provides an optional log message for when the capability degrades to FTS.

## Recall Candidates Service
The `recallCandidates` function implements a pre-merge candidate shortlist generator for narrowing candidates from "all pages" to "top-5 similar pages". It operates in two modes: **Vector mode** generates embeddings from the title and body to find similar concepts using cosine similarity, while **FTS-only mode** uses PostgreSQL's full-text search to provide results. It includes explicit degradation where results carry a mode indicator and enforces project scope, ensuring no results for cross-team queries or when the scope is invalid.

## Integration of findSimilarConcepts Service
In addition to the existing functionalities, a new service has been introduced:

### findSimilarConcepts — Scoped Semantic Nearest-Neighbour Query
The `findSimilarConcepts(scope, queryEmbedding, k)` function is a semantic nearest-neighbour query repository that returns the top-k most similar concept pages within a project using pgvector HNSW cosine distance. It implements SQL-level scoping and ensures secure and efficient querying through proper parameterization and boundary validation.

**Key Features:**
- **Scoping:** Supports project-level scoping with `ScopeContext`, enforcing `team_id` and `project_id`. Returns empty for requests outside the specified context.
- **Functionality:** It converts cosine distance to similarity: `similarity = 1 - distance`.
- **Validation:** Enforces limits on the number of results (between 1 and 100) and throws `InvalidVectorSearchError` for invalid input.
- **Integration Tests:** Robustly tested with 17 integration tests to cover expected success scenarios and boundary conditions.

## Important Files:
- **`apps/server/src/db/repositories/concepts-search.ts`**: Contains the search repository code handling FTS.
- **`apps/server/src/mcp/tools/search.ts`**: Implements the tool logic and audit handling.
- **`apps/server/src/mcp/tools/search.integration.test.ts`**: Contains integration tests covering the search functionality.
