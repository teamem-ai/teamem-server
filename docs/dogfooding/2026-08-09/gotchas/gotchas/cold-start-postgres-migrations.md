---
type: gotcha
uuid: 07a8f2c7-d963-42d1-a829-735982e14088
path: gotchas/cold-start-postgres-migrations
status: active
confidence: medium
title: Cold Start Issues with Postgres Migrations
tags:
  - postgres
  - migration
  - gotcha
lastConfirmed: 2026-08-09T05:14:29.000Z
firstSeen: 2026-08-09T05:14:29.000Z
createdAt: 2026-08-09T13:27:31.897Z
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
    commitSha: 81b96aa16de008a61d43dc72b74c7332a396ed45
    path: prs/138.md
    at: 2026-08-09T05:14:29.000Z
---
When using a fresh Postgres volume for a new server instance, ensure that the `TEAMEM_AUTO_MIGRATE` configuration is set to auto-apply pending migrations on server boot. Failure to do so will result in the instance starting with zero tables, which breaks the initial sign-in and team creation process. Documenting the manual migration step in the README is also essential to prevent confusion for existing setups.
