---
type: service
uuid: c525c09b-fd8e-4d1c-8249-b34f9d59cd3d
path: services/concept-page-persistence-repository
status: active
confidence: medium
title: Concept Page Persistence Repository
tags:
  - repository
  - persistence
  - concepts
lastConfirmed: 2026-07-19T11:53:59.000Z
firstSeen: 2026-07-19T11:53:59.000Z
createdAt: 2026-08-09T13:24:40.740Z
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
    commitSha: d8b8d265f962c38b5108d8e434f0eecf1b011c92
    path: prs/33.md
    at: 2026-07-19T11:53:59.000Z
---
# Concept Page Persistence Repository

The concept page persistence repository is responsible for handling the storage of concept pages in the database. It performs the following functions:

- Inserts concept page data, including the current path, evidence, and trusted contributors, in a single database transaction.
- Enforces constraints to ensure that evidence requirements are met, rejecting invalid submissions with `InvalidConceptError` if evidence is empty.
- Filters the contributors by ensuring only those with `webhook_verified` and `credential_bound` status are persisted; contributors marked as `client_claimed` or `unknown` are excluded silently.
- Utilizes existing database constraints to maintain path uniqueness and to ensure consistency of foreign keys across tenants.

This service includes a new repository class implemented in `apps/server/src/db/repositories/concepts-write.ts`, and is accompanied by integration tests located in `apps/server/src/db/repositories/concepts-write.integration.test.ts`, which cover various scenarios to validate the implementation.
