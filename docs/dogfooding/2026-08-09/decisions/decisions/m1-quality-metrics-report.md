---
type: decision
uuid: bf452a55-6a93-4812-8388-2804eccbc391
path: decisions/m1-quality-metrics-report
status: active
confidence: medium
title: Decisions regarding M1 Quality Metrics Report
tags:
  - m1-quality-report
  - design-decisions
  - metrics
lastConfirmed: 2026-07-23T05:39:18.000Z
firstSeen: 2026-07-23T05:39:18.000Z
createdAt: 2026-08-09T13:23:02.630Z
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
    commitSha: 8ce72e11543d7b47776059de123a618c82c94420
    path: prs/98.md
    at: 2026-07-23T05:39:18.000Z
---
In the recent M1 Quality Metrics Report, several design decisions were made:

1. **Token costs marked as 未測**: This is due to the current `LlmClient` and `EmbeddingClient` implementations not capturing usage metadata from provider responses, ensuring transparency by not fabricating numbers.
2. **Use of PostgreSQL FTS for F2 duplicate detection**: This method serves as an honest degradation when an embedding provider is unavailable, so it reflects the system's limitations accurately.
3. **Model pricing reference data**: This data is documented in the Markdown report in section 4.4 but is intentionally not hard-coded in the aggregation script to allow for updates without modifying the code.

These decisions underline the team's commitment to accuracy and clarity in metrics reporting.
