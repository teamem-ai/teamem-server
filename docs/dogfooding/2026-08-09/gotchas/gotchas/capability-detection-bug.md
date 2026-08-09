---
type: gotcha
uuid: ed8e0968-1101-4dd8-b0e8-2ae933dd6079
path: gotchas/capability-detection-bug
status: active
confidence: high
title: Capability Detection Bug in QA Script
tags:
  - qa
  - bug
  - script
lastConfirmed: 2026-07-23T05:06:24.000Z
firstSeen: 2026-07-23T05:06:24.000Z
createdAt: 2026-08-09T13:26:48.493Z
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
    commitSha: 1e4b33ee46dbd06a2b81156f5a6471190a91fb19
    path: prs/94.md
    at: 2026-07-23T05:06:24.000Z
---
The script `scripts/m1-semantic-recall.sh` has a bug in the `detect_semantic_capability` function that writes diagnostic output to stdout, causing all capability comparisons to fail. Consequently, the script always falls into the FTS-only else branch, suppressing assertion failures and exiting 0 regardless of any test outcomes. This means the QA script cannot detect a semantic recall regression until this bug is resolved. It is crucial to redirect all diagnostic output inside `detect_semantic_capability` to stderr to maintain proper functionality.
