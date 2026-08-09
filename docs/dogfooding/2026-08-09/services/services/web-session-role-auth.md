---
type: service
uuid: b9c04aea-11c5-4523-8037-bd3740166178
path: services/web-session-role-auth
status: active
confidence: medium
title: Web Session Middleware and Role-Based Authorization Middleware with Append-Only Audit Writer for Sensitive Reads
tags:
  - middleware
  - authorization
  - authentication
  - api
  - audit
  - service
  - purge
  - security
  - postgres
  - zod
lastConfirmed: 2026-07-30T11:54:33.000Z
firstSeen: 2026-07-30T11:54:33.000Z
createdAt: 2026-08-09T12:47:37.918Z
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
    commitSha: caa19e57389c0610d40fd6f05f95cf91a4bb5cba
    path: prs/117.md
    at: 2026-07-30T11:54:33.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: d34f1bd0ae422f01bd5af8f1d2df9fca13f8960d
    path: prs/120.md
    at: 2026-07-30T23:25:54.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 04d2189a4a64ec137b1058141f240fb1dbf7c8dd
    path: prs/118.md
    at: 2026-07-30T23:29:29.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: c469eca3b4372c8684ffb4be875e30902e93da8c
    path: prs/32.md
    at: 2026-07-19T12:13:29.000Z
---
# Web Session Middleware and Role-Based Authorization Middleware with Append-Only Audit Writer for Sensitive Reads

The web session middleware (`requireWebSession`) is responsible for parsing session cookies, verifying them against the database, fetching user and membership information, and deriving `ScopeContext` (all projects) and `TeamRole` from the membership data. The role-based access control middleware (`requireRole`) implements a role ladder system with roles: viewer < member < admin < owner. The functions `roleRank()` and `checkRole()` are exported for use by downstream services.

In addition, the `GET /v1/audit` API endpoint is part of the audit query service that retrieves audit log records with cursor pagination and role-based access control. It is designed for use by users with `admin` and `owner` roles, accessible via a web session cookie. The endpoint provides metadata-only columns (without content) and employs filters for `actor`, `action`, and `projectId`. It also implements security measures to prevent enumeration and avoid returning sensitive data in responses.

## Append-Only Audit Writer for Sensitive Reads
The design of the audit writer involves several key decisions:
1. The Zod `auditItem.strictObject` is utilized to enforce a runtime whitelist, ensuring only the defined fields are accepted.
2. The `AuditWriteParams` interface implements compile-time enforcement of the whitelisted fields.
3. Audit writes are configured to be append-only, meaning that no foreign key constraints are imposed on the `audit_log`, allowing rows to persist through purge operations.
4. The `auditId` (UUID) and `createdAt` fields are generated automatically, while the caller must provide the other whitelisted fields, ensuring security and integrity in sensitive data handling.

### Integration with Project-level Purge Endpoint
The **Project-level Purge Endpoint** is a secure API endpoint intended for owners to delete all project-scoped data in a specific team. This endpoint is defined as follows:

### Endpoint
- **POST /teams/:teamId/projects/:projectId/purge**

### Functionality
- Deletes all project-scoped data while preserving audit records and principals.
- Utilizes a single DB transaction to ensure all-or-nothing safety.
- Returns deletion counts for each table.

### Security Measures
- Requires a valid session cookie (`requireWebSession`).
- Validates team membership based on `:teamId` (`requireTeamMembership`).
- Restricts usage to owners only (`requireRole('owner')`).
- Returns a 404 response for cross-team access attempts.

### Verification Methods
- Successful verification ensured by passing 18 integration tests against a real PostgreSQL database, linting, and type checking.
