---
type: gotcha
uuid: b8f7da0f-534e-434b-9570-e7ffd50f884e
path: gotchas/missing-read-scope-enforcement
status: active
confidence: high
title: Missing Read Scope Enforcement on `get_page` Tool and ScopeContext
tags:
  - security
  - gotcha
  - mcp
  - access-control
  - scope
  - types
  - tenant-scoped
  - type-safety
lastConfirmed: 2026-07-22T05:13:37.000Z
firstSeen: 2026-07-22T05:13:37.000Z
createdAt: 2026-08-09T13:23:24.831Z
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
    commitSha: 9bb5a3b182fd1c8ee606298581011299f3466671
    path: prs/81.md
    at: 2026-07-22T05:13:37.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: d28679fb0400a4fec8ef560a7667125e4103cc4e
    path: prs/17.md
    at: 2026-07-19T00:57:26.000Z
---
# Missing Read Scope Enforcement on `get_page` Tool and ScopeContext

The `get_page` tool in the MCP server does not enforce a required `read` scope before retrieving full concept body data by UUID. As a result, any authenticated API key, regardless of its defined scopes, can invoke the `get_page` function and access sensitive data. This poses a security risk, as it bypasses the standard `requireScope('read')` validation that is present in other REST concept endpoints. It's crucial to implement scope checks to prevent unauthorized access to sensitive information.

## ScopeContext
`ScopeContext` is a tagged discriminated union designed to enforce tenant-scoped queries at the type level in our server code. It consists of two variants: `ProjectScope` and `AllProjectsScope`, which help to ensure type safety and proper handling of team and project identifiers.

### Key Features
- **Tagged Union**: The structure includes two variants that carry `teamId` and provide construction helpers for creating instances.
- **Type-Level Enforcements**: It ensures that `AllProjectsScope` has no project-specific data, and functions like `getProjectId` are designed to reject un-narrowed `ScopeContext`. 
- **Validation**: Incorporates Zod for boundary validation, extensive runtime tests, and compile-time assertions.
