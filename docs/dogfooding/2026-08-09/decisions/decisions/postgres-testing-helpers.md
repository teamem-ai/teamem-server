---
type: decision
uuid: da2044f0-774c-4867-a37c-6278af9ea66b
path: decisions/postgres-testing-helpers
status: active
confidence: medium
title: Design Decisions for PostgreSQL Integration Testing
tags:
  - postgresql
  - testing
  - decisions
  - integration
lastConfirmed: 2026-07-18T13:18:26.000Z
firstSeen: 2026-07-18T13:18:26.000Z
createdAt: 2026-08-09T13:24:00.337Z
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
    commitSha: c3b092c64aa28c1989db1d38e257e7ab5ec7870e
    path: prs/7.md
    at: 2026-07-18T13:18:26.000Z
---
The decision was made to implement a reusable real-database test helper for PostgreSQL integration testing in the codebase. Key design choices included: 
- No use of transactions, as constraint violations will abort the session; each test utilizes a dedicated client. 
- Separate clients are used for the `expectViolation` function to prevent test client poisoning from constraint violations. 
- Dynamic UUIDs are leveraged to avoid collisions with leftover data from other test suites. 
- Foreign key-safe cleanup order is ensured in the `afterAll` function. 
- All IDs generated during the test run are unique through a combination of a counter and timestamp. These choices enhance the reliability and isolation of tests against a real PostgreSQL instance.
