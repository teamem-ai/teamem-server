---
type: service
uuid: 9633e78b-ea48-4f8e-98d7-5ce3bb2e15f1
path: services/scoped-okf-bundle-download
status: active
confidence: medium
title: Scoped OKF Bundle Download Endpoint
tags:
  - okf
  - endpoint
  - export
  - download
lastConfirmed: 2026-08-09T12:32:49.000Z
firstSeen: 2026-08-09T12:32:49.000Z
createdAt: 2026-08-09T13:25:55.286Z
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
    commitSha: b56fea070b4648dec6b539abe8345be40bbc7fab
    path: prs/145.md
    at: 2026-08-09T12:32:49.000Z
---
The **scoped OKF bundle download endpoint** allows users to download a project-specific archive. The endpoint is implemented as **GET /v1/export?projectId=prj_...** which returns a deterministic `<project>-okf-0.1.tar.gz` archive. This archive contains the full bundle tree, including an `index.md` catalog and one individual page per concept under its frozen per-type directory. The endpoint requires authentication through shared middleware and restricts access based on the specified `projectId` to prevent unauthorized access to other projects.
