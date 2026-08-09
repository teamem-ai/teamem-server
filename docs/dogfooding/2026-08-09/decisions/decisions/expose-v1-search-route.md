---
type: decision
uuid: 13a91f9e-eabf-46a6-b9d0-e3e0c515869e
path: decisions/expose-v1-search-route
status: active
confidence: high
title: Expose POST /v1/search route with explicit limit validation
tags:
  - http
  - validation
  - search
  - api
  - dto
  - schema
lastConfirmed: 2026-07-23T03:31:19.000Z
firstSeen: 2026-07-23T03:31:19.000Z
createdAt: 2026-08-09T13:28:47.153Z
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
    commitSha: 1e9a32db36791360716a8aac8d9a6d05f62621a6
    path: prs/90.md
    at: 2026-07-23T03:31:19.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 5fa144f34843423254818c5c02751621a99e4e69
    path: prs/71.md
    at: 2026-07-21T23:21:15.000Z
---
We decided to expose the `POST /v1/search` route with explicit limit validation that returns a 400 status code when `limit > 100`, in compliance with the DUA-205 requirement. This choice improves error handling for requests exceeding the limit by providing structured details about the error response, which is crucial for client-side validation while also fixing Zod validation error formatting issues that could obscure these details. The implementation is supported by 17 unit tests that ensure the limit guard and error formatting function correctly.

### Search Request/Response DTOs

The `searchRequest` and `searchResponse` Data Transfer Objects (DTOs) are defined in `@teamem/schema` for the `POST /v1/search` endpoint. The `searchRequest` includes fields such as `projectId`, `query`, and optional parameters like `type`, `status`, and `limit` (default 20, max 100). The `searchResponse` consists of the search results array and includes flags such as `degraded` and `nextCursor`. This setup allows semantic searches with a relevance score and supports full-text search fallbacks, ensuring adherence to type safety and contract standards. The types follow the `z.strictObject` validation for enhanced reliability.

### Importance
These DTOs ensure type safety and schema validation using `z.strictObject`, reinforcing consistency across the application when handling search-related data.
