---
type: concept
uuid: 35776a09-cfe6-4f37-b16a-3db38264fdec
path: concepts/okf-bundle-format-contract
status: active
confidence: medium
title: OKF Bundle Markdown Renderer Service
tags:
  - okf
  - bundle
  - contract
  - schema
  - markdown
  - renderer
  - service
  - export
lastConfirmed: 2026-08-09T06:12:28.000Z
firstSeen: 2026-08-09T06:12:28.000Z
createdAt: 2026-08-09T13:27:17.526Z
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
    commitSha: 3de8dfc60591d6badf603f8b5a61ceb916eb4e23
    path: prs/140.md
    at: 2026-08-09T06:12:28.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 6209b463a1b487c51acce7c7303465ef92b724e2
    path: prs/144.md
    at: 2026-08-09T11:51:17.000Z
---
# OKF Bundle Markdown Renderer Service

The **OKF Bundle Markdown Renderer Service** (DUA-250 / M3-EXPORT-03) is responsible for rendering the full OKF bundle tree as part of the M3 export. It composes the M3 export slices already present in the repository and generates markdown files for the OKF reserved catalog and change log. The service operates by traversing the scoped export repository page by page and outputs various documents including:

- `index.md` - The catalog of reserved sections with relative links.
- `log.md` - A change log maintaining the order by `lastConfirmed`.

The service ensures determinism by maintaining a consistent order of rendering across repeated executions, irrespective of the size of the repository. It is designed as a read-only consumer of the existing `exportProject` repository, with no modification or side effects introduced during its operation.

## Verification
The service has undergone rigorous testing, including successful passes of linting, type checking, and integration tests against a real PostgreSQL database, validating its functionality and reliability.

## OKF Bundle Format Contract

The OKF bundle format contract defines the structure and mandatory components for a bundle in the `@teamem/schema` package. This contract is detailed in executable contract text and is associated with the M3 export workstream (DUA-248).

## Key Components:
- **Bundle layout:** Includes a reserved `index.md` catalog, `log.md` change log, and six directories for distinct concept types: `decisions/`, `gotchas/`, `conventions/`, `runbooks/`, `services/`, and `concepts/`.
- **Per-concept frontmatter:** Contains all necessary information regarding each concept in the bundle, excluding the body and evidence count, with the canonical UUID included.
- **Link resolution:** Ensures that links to concepts resolve correctly and preserves the integrity of UUIDs.

This contract lays the groundwork for ensuring that concepts are well-structured, verifiable, and maintainable within the schema framework, supporting future extensions and consistency.
