---
type: service
uuid: 5e8ce294-23a8-439c-b65f-6224f7794aae
path: services/to-concept-mapper
status: active
confidence: medium
title: toConcept Mapper
tags:
  - mapper
  - service
  - f1
  - aggregate
lastConfirmed: 2026-07-19T13:03:35.000Z
firstSeen: 2026-07-19T13:03:35.000Z
createdAt: 2026-08-09T13:22:38.733Z
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
    commitSha: 5d3ee696b25aa72fdab5426f801e3c93863b2a5d
    path: prs/40.md
    at: 2026-07-19T13:03:35.000Z
---
# toConcept Mapper

The `toConcept()` mapper is a core function within the server that constructs a complete concept page aggregate from validated F1 extract output and source event facts. It is responsible for generating UUIDs, paths, and timestamps for concept pages.

## Functionality
- Validates input based on predefined schema from `@teamem/schema`.
- Constructs evidence from multiple immutable source facts including CLI inputs, GitHub events, and more.
- If evidence cannot be constructed due to missing or invalid data, it returns `null`.

## Structure of Evidence
The evidence is built from the following types:
- CLI `cli_init`
- GitHub `github_commit`
- GitHub `github_pr`
- GitHub `github_issue`
- GitHub `github_pr_comment`
- MCP `mcp_write`

The service always initiates with a status of `active` for new concepts and includes contributor candidates for downstream repository filtering.
