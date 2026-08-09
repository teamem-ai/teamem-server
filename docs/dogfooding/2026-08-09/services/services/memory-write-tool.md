---
type: service
uuid: 9143e2f3-9096-458f-82e6-40584d5a64e0
path: services/memory-write-tool
status: active
confidence: medium
title: memory_write Tool
tags:
  - mcp
  - service
  - memory_write
lastConfirmed: 2026-07-22T07:05:30.000Z
firstSeen: 2026-07-22T07:05:30.000Z
createdAt: 2026-08-09T13:30:26.739Z
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
    commitSha: 2538d91ec6301e9fd71b5c089986d69470cb4915
    path: prs/83.md
    at: 2026-07-22T07:05:30.000Z
---
The `memory_write` tool is an implementation within the MCP (Memory Control Protocol) that allows agent sessions to actively store observations as `mcp_write` events through the ingestion pipeline. Specifically, it accepts parameters such as `content`, `title`, `suggestedType`, `tags`, and `projectId`. The tool constructs `mcp_write` events and follows a defined ingestion path: validate → stripPrivateTags → persist → enqueue. The implementation also includes a proper scope enforcement mechanism to ensure that operations are correctly isolated based on project scope.
