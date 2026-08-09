---
type: decision
uuid: db62771d-31bc-4207-9a5f-71a53a23e057
path: decisions/validate-server-env-vars
status: active
confidence: medium
title: Validation of Server Environment Variables
tags:
  - environment-variables
  - validation
  - zod
  - environment
  - error
  - bootstrap
lastConfirmed: 2026-07-18T12:42:53.000Z
firstSeen: 2026-07-18T12:42:53.000Z
createdAt: 2026-08-09T13:22:31.064Z
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
    commitSha: 9db811af6b9b08c9d4dc31a77f800171441976d5
    path: prs/8.md
    at: 2026-07-18T12:42:53.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 38bffac4b94bfc2cfa5f395dc332c7359fd10434
    path: prs/73.md
    at: 2026-07-21T23:17:21.000Z
---
# Validation of Server Environment Variables

We decided to implement strict Zod parsing for validating server environment variables, ensuring that malformed input is rejected before deployment. This decision supports the completion of DUA-132, preventing invalid configuration from causing issues in production. The parser now checks for valid URLs, ports, booleans, GitHub IDs, and ensures that keys for ambient bare providers are properly handled. This change is essential to maintain security and operational integrity in our deployments.

Additionally, the `parseServerEnv()` function throws an error when only `TEAMEM_DATABASE_URL` is set in the environment variables. The bootstrap process expects `DATABASE_URL` to be present, and if it is not, it throws a Zod validation error before the key creation process can complete. To fix this, ensure that both aliases are normalized before calling `parseServerEnv()`. Pass `{ ...process.env, DATABASE_URL: databaseUrl }` so the schema validator sees the already-resolved URL.
