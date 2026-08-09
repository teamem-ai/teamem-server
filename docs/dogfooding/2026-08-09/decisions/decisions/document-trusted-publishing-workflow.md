---
type: decision
uuid: 2fc4d188-deb5-4eb3-909a-ced1f651e028
path: decisions/document-trusted-publishing-workflow
status: active
confidence: medium
title: Document Trusted Publishing Workflow
tags:
  - documentation
  - workflow
  - npm
  - reproducibility
lastConfirmed: 2026-07-24T01:44:56.000Z
firstSeen: 2026-07-24T01:44:56.000Z
createdAt: 2026-08-09T13:27:57.652Z
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
    commitSha: 48a8b4766298037e48fd4312bf5da131c29c5368
    path: prs/101.md
    at: 2026-07-24T01:44:56.000Z
---
# Decision: Document Trusted Publishing Workflow

The team decided to document the completed 0.1.0 manual bootstrap of the trusted publishing workflow to ensure that the tokenless OIDC release process is reproducible for maintainers and to prevent duplicate publication attempts for immutable npm versions. This documentation includes recording the exact npm Trusted Publisher configuration and adding the annotated-tag workflow for subsequent schema releases.

## Rationale
This decision helps in maintaining clarity and provides a reference for maintainers on how to perform releases correctly without duplication or errors.

## Context
This was documented in pull request #101, authored by duan-li.
