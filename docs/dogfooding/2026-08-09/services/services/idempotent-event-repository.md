---
type: service
uuid: 46d8ae59-06e1-414d-acfc-04bf272a70e2
path: services/idempotent-event-repository
status: active
confidence: medium
title: Idempotent Event Repository
tags:
  - repository
  - event
  - idempotency
lastConfirmed: 2026-07-19T11:48:25.000Z
firstSeen: 2026-07-19T11:48:25.000Z
createdAt: 2026-08-09T13:27:40.504Z
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
    commitSha: e244a087f9ce732373f5b6ae02b9e1208920d0be
    path: prs/36.md
    at: 2026-07-19T11:48:25.000Z
---
The Idempotent Event Repository is implemented in `apps/server/src/db/repositories/events.ts`. It provides three-state idempotency with checks for duplicates and conflict errors. The repository enforces unique constraints based on a combination of `project_id`, `channel`, `connector_kind`, `delivery_id`, and `item_key`. It handles race conditions and preserves all required provenance facts, ensuring that queries are scoped to the correct `team_id` and `project_id`.

### Features
- **Three-state idempotency**: Offers states such as `inserted`, `duplicate`, or throwing `IdempotencyConflictError` based on hash checks.
- **Race-condition handling**: Implements a pre-check SELECT and catches unique constraint violations to manage concurrent inserts.
- **Provenance Preservation**: All relevant metadata is stored, including the source and actors involved.

This repository fits into the server's architecture by managing event data in a way that supports multi-tenancy while ensuring data integrity.
