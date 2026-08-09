---
type: service
uuid: 31ea0234-a5a8-479c-99c0-8c25051ced63
path: services/embedding-client
status: active
confidence: medium
title: EmbeddingClient Service for Text-to-Vector Generation
tags:
  - embedding
  - llm
  - text-to-vector
  - adapter
  - refactor
lastConfirmed: 2026-07-21T23:32:11.000Z
firstSeen: 2026-07-21T23:32:11.000Z
createdAt: 2026-08-09T13:22:50.254Z
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
    commitSha: 146550687deb316d290c02fe9f7e9de207b52b39
    path: prs/72.md
    at: 2026-07-21T23:32:11.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: bdd71469e7ad8ccc5960936038fc9aaafd504d65
    path: prs/78.md
    at: 2026-07-22T05:15:03.000Z
---
The `EmbeddingClient` service defines an interface (`port.ts`) and a factory function (`factory.ts`) that handles text-to-vector embedding generation targeting 1536 dimensions. The `EmbeddingClient` interface includes a method `generate(inputs: string[]): Promise<number[][]>` for generating vectors. The factory function, `createEmbeddingClient(config, deps?)`, allows for creating instances for various embedding endpoints (`openai`, `openrouter`, `custom`) and gracefully handles unsupported configurations (`claude`) by returning `null`. It supports injectable `fetch` for testing without external dependencies. This service is part of the larger API and should be utilized for generating embeddings in applications.

Additionally, we decided to extract the inline embedding HTTP call logic from `factory.ts` into a new file, `openai-compatible.adapter.ts`, following the established LLM adapter pattern. This change improves code organization by delegating all HTTP call responsibilities to the adapter, while ensuring backward compatibility through re-exports from `factory.ts`. The adapter maintains strict validation and error handling, preserving functionality without altering behavior. This refactor was deemed necessary to enhance maintainability and adhere to our design principles.
