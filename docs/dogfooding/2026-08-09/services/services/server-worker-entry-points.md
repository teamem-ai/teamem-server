---
type: service
uuid: fd3f6405-062d-430c-9b81-3c6272ef6143
path: services/server-worker-entry-points
status: active
confidence: medium
title: Server and Worker Process Entry Points and Hono HTTP Runtime Decision
tags:
  - process
  - server
  - worker
  - lifecycle
  - shutdown
  - entrypoint
  - legacy
  - decision
  - http
  - runtime
  - hono
  - dev-scripts
lastConfirmed: 2026-07-18T13:37:50.000Z
firstSeen: 2026-07-18T13:37:50.000Z
createdAt: 2026-08-09T13:22:44.646Z
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
    commitSha: 5078f94cb273840a6b1eee1281fcb1c032c3c290
    path: prs/13.md
    at: 2026-07-18T13:37:50.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 3865afdc6d1238b79983cb106b11c2c1c1282e36
    path: prs/52.md
    at: 2026-07-20T00:41:28.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: c6d85c833d84386ddb48af0b3a21dc911408a8a1
    path: prs/42.md
    at: 2026-07-19T12:51:48.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 979cc6e20d53e558526e76133aee4d582194acc1
    path: prs/4.md
    at: 2026-07-18T11:28:26.000Z
---
# Server and Worker Process Entry Points and Hono HTTP Runtime Decision

The recent updates introduced two independent, production-shaped process entrypoints for the server and worker processes in the `apps/server` directory:

1. **Server Process**: Implemented in `src/index.ts`, this process includes functions to initialize the database connection, check connectivity, and start the server. It features graceful shutdown capabilities when receiving termination signals (SIGTERM/SIGINT), supported by the shared `installShutdownHandlers` to handle these signals gracefully. If the HTTP server's `listening` event is not properly awaited, it may lead to EADDRINUSE failures during startup, which can result in uncatchable crashes.  

2. **Worker Process**: Defined in `src/worker.ts`, similar to the server process, this worker process also manages a database connection while awaiting tasks from the pg-boss queue. It includes environmental and database readiness checks before operating. Logging should be in place to capture readiness detection and handle exit scenarios correctly, ensuring clean startup and shutdown processes.  

## Decision to Use Hono HTTP Runtime and Dev Scripts
The team has decided to freeze the HTTP runtime to use **Hono** on Node.js. This choice was made due to its ESM-native capability and raw body access, which are beneficial for our server's architecture. Additionally, we are adopting **tsup** for production builds and **tsx** for development hot-reload. This decision entails creating both server and worker entrypoints along with necessary middleware, and establishing configurations for testing and production efficiency.

The rationale for this decision includes:
- Hono's ESM-native design improves compatibility with modern JavaScript features.
- The ability to access raw request bodies allows for greater flexibility in handling incoming data.

Alternative options were considered, but Hono was selected as it best fits our requirement for a lightweight, efficient HTTP server that supports our development workflow.

These entry points enhance the application's lifecycle management, ensuring clean startup and shutdown processes. This decision details are documented in ADR 001 found in `docs/adr/001-http-runtime-and-dev-scripts.md`.  

## Decision to Remove Legacy All-in-One Entrypoint
We decided to remove the legacy `isMain` block from `server.ts` because it acted as a competing entrypoint, which bypassed the composition root's ordered startup and shutdown process. This change ensures that `index.ts` remains the canonical entrypoint, promoting a clear startup sequence (DB → queue → HTTP → worker) and shutdown sequence (worker → queue → HTTP → database). Removing this deprecated code helps prevent confusion among team members regarding the entrypoints for the server. 

These entry points are crucial for efficient management of both server and worker processes.
