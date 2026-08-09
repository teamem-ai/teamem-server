---
type: service
uuid: c0008db5-7cb3-4719-882e-c29747d222df
path: services/upsert-principal-repository
status: active
confidence: medium
title: Principal Upsert Repository
tags:
  - upsert
  - repository
  - principal
  - database
lastConfirmed: 2026-07-19T06:18:40.000Z
firstSeen: 2026-07-19T06:18:40.000Z
createdAt: 2026-08-09T13:22:16.538Z
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
    commitSha: 331251c0ac2661173c82052de2b22bf821b1016f
    path: prs/25.md
    at: 2026-07-19T06:18:40.000Z
---
The `upsertPrincipal()` repository function is responsible for creating or updating a principal associated with a stable provider identity within a tenant scope. It functions by utilizing the upsert key composed of `(teamId, provider, providerKind, providerUserId)`, ensuring that the mutable `displayLogin` is not included in the identity. In case of a conflict, the function updates only the `display_login`, while preserving the `principalId` and `kind` (human/service). Upon successful execution, it returns status flags indicating `{ id, created, updated }`. Additionally, it exports a `findPrincipal()` read helper to access the same identity tuple.
