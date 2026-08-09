---
type: runbook
uuid: ac6f40db-7913-4582-9857-f59c5a7e6864
path: runbooks/run-governance-security-script
status: active
confidence: high
title: How to run the M2 governance and security verification script
tags:
  - governance
  - security
  - scripting
  - runbook
lastConfirmed: 2026-08-01T01:36:44.000Z
firstSeen: 2026-08-01T01:36:44.000Z
createdAt: 2026-08-09T13:25:38.627Z
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
    commitSha: 54f7bc57b48bf31130f60d596c503988e5fae7b7
    path: prs/136.md
    at: 2026-08-01T01:36:44.000Z
---
## How to run the governance and security verification script
To execute the M2 governance and security verification test script, follow these steps:

1. **Make the script executable**: Run the following command to change the permissions:
   ```bash
   chmod +x scripts/m2-governance-security.sh
   ```
2. **Execute the script**: Run the script using the command below:
   ```bash
   ./scripts/m2-governance-security.sh
   ```

### Requirements
This script requires the following tools:
- docker
- pnpm
- curl
- jq
- openssl
