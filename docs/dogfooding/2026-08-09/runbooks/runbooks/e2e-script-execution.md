---
type: runbook
uuid: 1800dd79-5519-4c1f-bda0-8a88546fa075
path: runbooks/e2e-script-execution
status: active
confidence: medium
title: End-to-End E2E Script Execution for M3 Check
tags:
  - e2e
  - script
  - runbook
  - M3
lastConfirmed: 2026-08-09T07:56:20.000Z
firstSeen: 2026-08-09T07:56:20.000Z
createdAt: 2026-08-09T13:26:43.097Z
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
    commitSha: 6930cb17f886d312e6f44e2ea38598de85fbe83f
    path: prs/142.md
    at: 2026-08-09T07:56:20.000Z
---
## How to run the E2E script
This document outlines the steps to execute the end-to-end (E2E) script `scripts/e2e.sh` as part of the hard M3 exit check. Follow these steps to ensure a successful run:

### Trigger
Run this script when you need to perform an E2E integration test for M3 compliance.

### Steps
1. **Up**: Build and start the real compose stack (Postgres + Server + Worker in standard mode) on an isolated compose project (`teamem-e2e`), waiting for liveness and readiness checks to pass.
2. **Ingest**: Bootstrap an isolated team/project/API key inside the server container, then submit a real `cli_init` event (`compile=true`) via `POST /v1/events`.
3. **Compile**: Poll the pg-boss compile job; ensure it completes and produces at least one concept page.
4. **MCP Search**: Initialize `tools/list` and `tools/call search` on `/mcp`; verify the compiled concept UUID appears in the search index rows.
5. **Cleanup**: Run `compose down --volumes` to ensure the next run is idempotent and repeatable.

### Exit Codes
- **0**: GREEN — the full loop verified end to end.
- **1**: RED — a step failed; detailed failure information is provided.
- **2**: SKIP — the environment cannot satisfy the check (due to missing dependencies or configuration issues).

### Environment Requirements
- Ensure you have a real BYO LLM provider key for the green path.
- Configure the environment variables as needed, ensuring sensitive information like `POSTGRES_PASSWORD` is handled securely.

To execute, run `./scripts/e2e.sh` on a clean machine with the correct environment setup.
