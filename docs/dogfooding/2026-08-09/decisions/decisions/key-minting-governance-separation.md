---
type: decision
uuid: 12341b45-9e16-4c2a-9cc3-f963d6770f39
path: decisions/key-minting-governance-separation
status: active
confidence: medium
title: Key Minting and Governance Separation Decisions
tags:
  - key minting
  - API governance
  - security
lastConfirmed: 2026-07-30T23:38:45.000Z
firstSeen: 2026-07-30T23:38:45.000Z
createdAt: 2026-08-09T13:24:32.853Z
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
    commitSha: 06abeeef2a372706647d8c5385aedc38c24ee451
    path: prs/122.md
    at: 2026-07-30T23:38:45.000Z
---
The decision was made to have a plaintext token returned exactly once for key minting, with only the SHA-256 hash stored in the database. This was to enforce security and governance. Normal keys require a `projectId`, while `allProjects` keys are team-wide. The API keys cannot access web-session endpoints, leading to a 401 response, ensuring cross-team isolation. Furthermore, scope derivation is based on team membership rather than client headers.
