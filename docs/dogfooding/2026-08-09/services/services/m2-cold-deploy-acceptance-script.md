---
type: service
uuid: bb8da206-4d0e-4a5a-9252-1cee0f9f66e2
path: services/m2-cold-deploy-acceptance-script
status: active
confidence: medium
title: M2 Cold Deploy Acceptance Script
tags:
  - m2
  - cold-deploy
  - acceptance-test
  - automation
lastConfirmed: 2026-08-01T00:02:06.000Z
firstSeen: 2026-08-01T00:02:06.000Z
createdAt: 2026-08-09T13:30:52.836Z
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
    commitSha: 36f874a51200a03896b6065e1b27679e218cc1d1
    path: prs/133.md
    at: 2026-08-01T00:02:06.000Z
---
The **M2 Cold Deploy Acceptance Script** (`scripts/m2-cold-deploy.sh`) automates the cold deployment testing process, performing all necessary prerequisites, validation checks, and health checks. It presents manual steps as a checklist and generates a detailed Markdown report documenting each checkpoint's status. The script is designed to handle missing configurations gracefully, documenting what steps were skipped without failing the execution. Additionally, it integrates testing for critical workflows in the system's architecture.
