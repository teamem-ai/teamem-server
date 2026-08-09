---
type: decision
uuid: 03755c7f-aa57-421f-8128-e44a68987200
path: decisions/production-docker-image
status: active
confidence: high
title: Production Docker Image Build Decision
tags:
  - docker
  - decisions
  - deployment
lastConfirmed: 2026-07-18T14:03:27.000Z
firstSeen: 2026-07-18T14:03:27.000Z
createdAt: 2026-08-09T13:32:25.226Z
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
    commitSha: 3c9373f58eaa799c92a746f50dc5b43ffc16c26f
    path: prs/15.md
    at: 2026-07-18T14:03:27.000Z
---
We decided to add a reproducible multi-stage production image with a pinned Node base and frozen `pnpm` install to make DUA-138 production builds repeatable. This decision allows us to provide one image for the standard and all-in-one deployment topologies while ensuring production-only dependencies are included under a non-root user. Additionally, runtime health checking is implemented, and local metadata, secrets, dependencies, and generated output are excluded from the build context.
