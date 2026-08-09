---
type: service
uuid: b0140138-f497-45dd-862f-542968b7dca2
path: services/auth-entry-pages
status: active
confidence: medium
title: Auth Entry Pages - Login and Invite Acceptance with GitHub OAuth
tags:
  - auth
  - login
  - invite
  - service
  - authentication
  - github
  - oauth
  - security
  - decision
  - deployment
  - docker
  - web-spa
  - middleware
  - scope
  - hono
lastConfirmed: 2026-07-31T02:53:11.000Z
firstSeen: 2026-07-31T02:53:11.000Z
createdAt: 2026-08-09T13:22:22.908Z
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
    commitSha: 8dd353ca46cff5eb148c8a516f088f9ae4dcbf4f
    path: prs/124.md
    at: 2026-07-31T02:53:11.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 80ee079ece74eb3ac02bbbada112d00aaf8d7798
    path: prs/119.md
    at: 2026-07-30T23:13:39.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 3449a518272414776096eb360f3e814ee89226f8
    path: prs/116.md
    at: 2026-07-30T11:27:20.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: f858da55d38ef899e01294a711ea64ef795a92ad
    path: prs/111.md
    at: 2026-07-30T09:57:46.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 2a8ef7a2dfcf0d3631f5908135dbc0d899d3e698
    path: prs/131.md
    at: 2026-07-31T23:33:55.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 1ffe7a7738c47c28f7729130fe997f2d8b0a634d
    path: prs/130.md
    at: 2026-07-31T23:04:55.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 0d5fdc1530c59cabdff9d8487c680afc2054dc23
    path: prs/50.md
    at: 2026-07-20T00:36:35.000Z
---
The **Auth Entry Pages** consists of two main components:

1. **Login Page (`/login`)**  
   - A user interface for logging in, featuring a centered card with the logo, tagline, and 'Sign in with GitHub' button. It includes handling for various states: OAuth failures, unconfigured apps, and team invitation guides.  
   - The team decided to implement GitHub OAuth login using existing GitHub App credentials rather than creating a separate OAuth app. This choice allows for a unified authentication flow and session management with CSRF protection and enhanced security measures, such as HMAC signature verification and token expirations. The decision includes handling for users without team memberships and continuous session security through secure cookies.  
   - Additionally, the team decided to wire `TEAMEM_GITHUB_OAUTH_CLIENT_ID` and `TEAMEM_GITHUB_OAUTH_CLIENT_SECRET` into the existing GitHub App environment config so that OAuth login and webhook ingestion share the **same** GitHub App credentials. This decision was made to ensure consistency and simplify configuration management, as both functionalities are reliant on the same set of credentials. This approach helps avoid potential confusion or errors that may arise from having separate configurations for OAuth and webhook ingestion.

2. **Invite Acceptance Page (`/join?token=inv_...`)**  
   - An interface for accepting team invites. It displays a summary with the team name and inviter details, enabling user sign-in or displaying messages for invalid links.  
   - This page integrates directly with the **Invite Links Service**, which provides functionalities for generating and accepting team invitation links. The Invite Links Service generates a 7-day single-use invite link containing a plaintext token that authenticated users can accept, creating team membership atomically.

### Extended Functionality for GitHub OAuth  
The `requireAuth` and `requireScope` middleware are responsible for handling Bearer-token authentication and scope enforcement in the Hono framework. The `requireAuth` middleware extracts the Bearer token from the Authorization header, validates it against a database of hashed tokens, and attaches an `AuthContext` to the request context. If the token is missing, malformed, unknown, or revoked, it returns a 401 Unauthorized response with no information leakage. The `requireScope` middleware verifies that the authenticated key has all specified scopes, returning a 403 Forbidden response if the requirements are not met. These middleware components are defined in `apps/server/src/http/auth.ts` and are designed to be reusable across the application.

### Operational Details of Invite Links Service:  
- **Generate Invite**: `POST /teams/:teamId/invites` — Returns a link with a plaintext token for a specified role.  
- **Accept Invite**: `POST /teams/:teamId/invites/accept` — Validates the token, creates a membership, and marks the invite as used.  
- **Security**: Only SHA-256 token hash is stored in the database; plaintext appears only once when generated.
