---
type: service
uuid: 821fcdf4-8dda-432c-9e47-99b5ac91fd8e
path: services/merge-into-concept
status: active
confidence: high
title: mergeIntoConcept – F2 Persistence Layer for Concept Merges
tags:
  - merge
  - service
  - persistence
  - f2
lastConfirmed: 2026-07-23T04:21:02.000Z
firstSeen: 2026-07-23T04:21:02.000Z
createdAt: 2026-08-09T13:31:54.715Z
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
    commitSha: 1fc3cb0382bf97d5800a9197383abc64976faaac
    path: prs/92.md
    at: 2026-07-23T04:21:02.000Z
---
# mergeIntoConcept

`mergeIntoConcept()` is a persistence function that handles the F2 merge decision process. It manages three merge relationships within a single scoped transaction:

| Relationship  | Rewrite body | Refresh `last_confirmed` | Status change  |
|---------------|--------------|--------------------------|----------------|
| `confirms`    | ✅            | ✅ (Q10)                 | As decided     |
| `extends`     | ✅            | ❌                       | As decided     |
| `contradicts` | ✅            | ❌                       | → `disputed`   |

### Key Features
- **Evidence Deduplication**: Utilizes content fingerprinting to prevent duplicates when merging evidence.
- **Trusted Contributor Filter**: Only adds contributors who are `webhook_verified` or `credential_bound`, excluding `client_claimed`.
- **Atomic Transactions**: Ensures database integrity by committing transactions or rolling back on errors.
- **Cross-team Isolation**: Throws `MergeTargetNotFoundError` for requests targeting unauthorized teams.

### Verification and Testing
The implementation includes a comprehensive suite of 19 integration tests against a real PostgreSQL setup which cover all anticipated scenarios and validate correctness of the merge operation.

**Files Changed**: 
- `apps/server/src/db/repositories/concepts-merge.ts`
- `apps/server/src/db/repositories/concepts-merge.integration.test.ts`
