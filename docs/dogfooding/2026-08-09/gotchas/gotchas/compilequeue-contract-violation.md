---
type: gotcha
uuid: a601ad75-72b4-4978-876d-7cabefbb5e9b
path: gotchas/compilequeue-contract-violation
status: active
confidence: high
title: Producer/Consumer Contract Violation in CompileQueue
tags:
  - compiler
  - queue
  - gotcha
lastConfirmed: 2026-07-28T12:13:05.000Z
firstSeen: 2026-07-28T12:13:05.000Z
createdAt: 2026-08-09T13:28:33.283Z
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
    commitSha: ec316e3e52eb1e7f6d2123818f0089f159311a06
    path: prs/107.md
    at: 2026-07-28T12:13:05.000Z
---
The `CompileQueue.send` method previously accepted a bare `Record<string, unknown>` as input. This absence of a defined contract between producers and consumers led to silent failures where jobs would remain in a `queued` state indefinitely due to missing required fields. Every producer except `POST /v1/compilations` failed to include the necessary `teamId` and `projectId`, triggering a guard that left jobs unprocessed. This trap may lead to job hangs and incorrect job statuses if not addressed.
