---
type: service
uuid: 4ddfd233-6eca-48f4-a902-da80975e47b4
path: services/m1-why-moment-demo-script
status: active
confidence: medium
title: M1 why-moment end-to-end demo script
tags:
  - demo
  - script
  - end-to-end
  - m1
lastConfirmed: 2026-07-23T04:53:40.000Z
firstSeen: 2026-07-23T04:53:40.000Z
createdAt: 2026-08-09T13:21:58.790Z
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
    commitSha: b1c24f89dab9b43ed247cfef391d0315d054a1bd
    path: prs/96.md
    at: 2026-07-23T04:53:40.000Z
---
The M1 "Why" moment end-to-end demo script located at `scripts/m1-why-moment.sh` is designed as a demonstration for design partners. It ingests a decision event containing PR discussion and implementation commit, compiles the decision, searches for the decision concept, retrieves the full concept detail, and verifies that the decision page contains the conclusion, the PR discussion link, and the commit permalink that links back to the relevant GitHub resources. This script includes various functional checks to ensure it meets the expected outcomes during its execution.
