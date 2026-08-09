---
type: decision
uuid: e210980c-8ac9-4e24-9f05-1e05fc20859a
path: decisions/onboarding-wizard-design
status: active
confidence: medium
title: Design Decisions for Onboarding Wizard Implementation
tags:
  - onboarding
  - design
  - decision
lastConfirmed: 2026-07-31T02:45:10.000Z
firstSeen: 2026-07-31T02:45:10.000Z
createdAt: 2026-08-09T13:29:22.045Z
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
    commitSha: 0d57d82623301ce5fdef7f341434b892e1be0e11
    path: prs/125.md
    at: 2026-07-31T02:45:10.000Z
---
The team made several key design decisions for the onboarding wizard implementation, which are as follows: 1. The wizard renders outside the AppShell to provide a focused flow. 2. User progress is persisted in sessionStorage, allowing users to return mid-flow. 3. An explicit warning banner is displayed for FTS degradation, emphasizing its importance. 4. The key plaintext is shown only once, with a warning indicating that it won't be visible again. 5. The waiting state shows all-zero counts along with a concrete troubleshooting checklist, ensuring users never see fake data. 6. All API calls are routed through the public HTTP API, avoiding direct imports of server internals. 7. Comprehensive CSS utility classes were added to align the web app with the design system.
