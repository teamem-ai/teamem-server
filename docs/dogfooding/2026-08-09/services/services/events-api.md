---
type: service
uuid: 2c19b7e6-7ff5-4995-9628-1bf85b9a5192
path: services/events-api
status: active
confidence: medium
title: Events API
tags:
  - api
  - events
  - service
lastConfirmed: 2026-07-20T03:56:19.000Z
firstSeen: 2026-07-20T03:56:19.000Z
createdAt: 2026-08-09T13:29:27.008Z
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
    commitSha: ad02a1b06dc844288e16999a52f19075867d94e7
    path: prs/56.md
    at: 2026-07-20T03:56:19.000Z
---
The Events API implements two key endpoints: `GET /v1/events`, which returns a cursor-paginated list of event summaries ordered by `created_at` descending with optional filtering, and `GET /v1/events/:id`, which provides detailed information about a specific event with a redacted payload. Key features include strict limit enforcement, scope enforcement based on project keys, and exclusion of payloads from list responses.
