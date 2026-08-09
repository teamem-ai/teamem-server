---
type: decision
uuid: 0e26700a-b3a9-4d34-bff8-71b04a0dcd18
path: decisions/budget-strategy-context-injection
status: active
confidence: medium
title: Budget Strategy for Context Injection Endpoint
tags:
  - context-injection
  - budget-strategy
  - design-decision
lastConfirmed: 2026-07-30T09:59:54.000Z
firstSeen: 2026-07-30T09:59:54.000Z
createdAt: 2026-08-09T13:23:10.234Z
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
    commitSha: 8278c945d6ff2678358636e92c298b714c7e40f1
    path: prs/114.md
    at: 2026-07-30T09:59:54.000Z
---
The budget strategy for the new SessionStart context injection endpoint `GET /v1/context` involves several key design decisions to ensure efficient token usage and response structure:

1. **Sort by confidence**: Concepts are sorted by confidence in descending order (high → medium), and then by `last_confirmed` in descending order. Low-confidence concepts are excluded.
2. **Contribution to the output**: Each included concept contributes its title, a one-line body summary, and a link to its UUID in the format `teamem://concept/<uuid>`.
3. **Token budget limitation**: The procedure will stop adding concepts when doing so would exceed the approximate 800 token budget (around 3200 characters).
4. **Response reporting**: The response will report `budgetUsed`, `conceptsIncluded`, and `conceptsAvailable` to provide transparency about the output.

This method ensures that the response is comprehensive while adhering to token limitations.
