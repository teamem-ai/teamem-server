---
type: runbook
uuid: 0f1fc369-f863-4427-8d7b-4c72bc2c8149
path: runbooks/run-m0-compose-smoke-script
status: active
confidence: medium
title: How to Run m0-compose-smoke.sh for Docker Compose Validation
tags:
  - docker
  - compose
  - smoke-test
  - testing
lastConfirmed: 2026-07-20T13:36:05.000Z
firstSeen: 2026-07-20T13:36:05.000Z
createdAt: 2026-08-09T13:23:31.846Z
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
    commitSha: 0e1a2a3406ef584175770745764781f5e75a7cef
    path: prs/68.md
    at: 2026-07-20T13:36:05.000Z
---
# How to Run

To execute the smoke test script for validating Docker Compose deployment topologies, follow these steps:

### Standard Mode (3 Containers)
```bash
POSTGRES_PASSWORD='<strong>' ./scripts/m0-compose-smoke.sh --mode standard
```

### All-in-One Mode (2 Containers, Embedded Worker)
```bash
POSTGRES_PASSWORD='<strong>' ./scripts/m0-compose-smoke.sh --mode all-in-one
```

### Running via pnpm
For running the tests using pnpm, use the following commands:
```bash
pnpm --filter @teamem/server test:compose -- --mode standard
pnpm --filter @teamem/server test:compose -- --mode all-in-one
```
