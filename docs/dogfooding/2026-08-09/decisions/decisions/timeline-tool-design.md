---
type: decision
uuid: c8c468df-efb7-43e3-a140-368b90e40501
path: decisions/timeline-tool-design
status: active
confidence: high
title: Key design decisions for the MCP timeline tool
tags:
  - mcp
  - decision
  - design
  - timeline
lastConfirmed: 2026-07-22T06:02:44.000Z
firstSeen: 2026-07-22T06:02:44.000Z
createdAt: 2026-08-09T13:31:01.115Z
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
    commitSha: a87cfdddf8b244f58a438300d5deecbcbf343df8
    path: prs/82.md
    at: 2026-07-22T06:02:44.000Z
---
The key design decisions for the timeline MCP tool implementation include:

- **Timeline sorted by `occurred_at DESC`**: This design choice ensures that the timeline displays events in descending order based on their occurrence time, which improves usability compared to sorting by `created_at`.
- **Utilization of existing cursor infrastructure**: The tool leverages the existing cursor functionality through a new `timeline` resource variant. This choice helps maintain consistency in how pagination is handled across tools.
- **Compact entries**: The decision was made to include only essential fields in the timeline tool output, specifically, `id`, `occurredAt`, `kind`, `externalId`, `title`, `actor`, and `url`, while excluding the payload to keep the response lightweight.
- **Cross-team access management**: The implementation returns an empty set for cross-team access to prevent unintended data exposure, aligning with best practices for data security.
- **Audit logging**: An audit record is written on every invocation of the timeline tool, ensuring that actions can be tracked. This is a best-effort approach, which balances performance with accountability in logging operations.
