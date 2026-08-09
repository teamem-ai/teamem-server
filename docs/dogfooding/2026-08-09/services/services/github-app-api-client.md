---
type: service
uuid: 64575abb-838f-45db-a405-31730c0ae5d9
path: services/github-app-api-client
status: active
confidence: medium
title: GitHub App API Client
tags:
  - github
  - api
  - client
lastConfirmed: 2026-07-19T12:35:25.000Z
firstSeen: 2026-07-19T12:35:25.000Z
createdAt: 2026-08-09T13:22:04.595Z
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
    commitSha: 2a1f1ea7b728b2839edcf54bec91f5ed52e138d6
    path: prs/35.md
    at: 2026-07-19T12:35:25.000Z
---
The GitHub App API Client is a minimal API client implemented in TypeScript that interfaces with the GitHub API. It provides a thin `fetch` wrapper with Bearer token authentication derived from a configuration-driven credentials provider. This client implements the `GET /repos/{owner}/{repo}/commits/{sha}/pulls` endpoint, which is crucial for associating commits with pull requests. It is designed to handle specific error types including `unauthorized`, `not_found`, `rate_limited`, and `server_error`.
