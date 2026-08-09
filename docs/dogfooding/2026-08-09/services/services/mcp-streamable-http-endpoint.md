---
type: service
uuid: 68daf22c-9122-41ed-9c87-5dcfc9036f9d
path: services/mcp-streamable-http-endpoint
status: active
confidence: medium
title: MCP Streamable HTTP Endpoint
tags:
  - mcp
  - http
  - service
  - bearer-auth
lastConfirmed: 2026-07-21T23:19:10.000Z
firstSeen: 2026-07-21T23:19:10.000Z
createdAt: 2026-08-09T13:27:09.485Z
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
    commitSha: 67eafc181b6903b55e00ac4125b893c5de028a39
    path: prs/74.md
    at: 2026-07-21T23:19:10.000Z
---
The MCP (Model Context Protocol) streamable HTTP endpoint, implemented at `POST /mcp`, utilizes Bearer-token authentication and JSON-RPC 2.0 for communication. It includes an initialization handshake to provide capabilities and supports tools within a `ToolRegistry` for future expansion.

### Features:
- **Authentication:** Utilizes existing `requireAuth` middleware for Bearer-token authentication.
- **Functionality:** Handles incoming JSON-RPC requests, processes `initialize`, `tools/list`, and various notifications, returning appropriate HTTP error codes and responses as per the MCP specification.
- **Error Management:** Supports custom error responses for parse issues, invalid requests, and unknown methods, returning standard HTTP response codes for each case.
