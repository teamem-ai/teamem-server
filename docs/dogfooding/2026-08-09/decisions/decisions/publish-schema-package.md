---
type: decision
uuid: 395f13da-f678-476c-8408-61c82c73f70a
path: decisions/publish-schema-package
status: active
confidence: medium
title: Publishing and Release Steps for the @teamem/schema Package
tags:
  - npm
  - schema
  - decision
  - release
  - runbook
lastConfirmed: 2026-07-24T01:07:24.000Z
firstSeen: 2026-07-24T01:07:24.000Z
createdAt: 2026-08-09T13:28:12.541Z
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
    commitSha: dcdc16271c49c9de074b82653f2bdd2a30ddc4ee
    path: prs/100.md
    at: 2026-07-24T01:07:24.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 3bbf74d9046145f3c04641028270d03c94feec76
    path: prs/143.md
    at: 2026-08-09T09:43:52.000Z
---
# Decision: Publishing and Release Steps for the @teamem/schema Package

The team decided to publish the `@teamem/schema` npm package as version `0.1.0` for the CLI repository to remove the dependency on a sibling `teamem-server` checkout. This decision was made to ensure that the CLI can consume the released semver package from the public npm registry without relying on local or cross-repository setups, thus improving maintainability and reducing complexity.

### Release Steps for @teamem/schema Package
After merging the release PR for `@teamem/schema`, follow these steps to complete the release process:

1. Create and push an annotated tag `schema-v0.2.0` on the merged commit.
2. Watch the **Publish schema package** workflow in GitHub Actions.
3. Run the command `npm view @teamem/schema@0.2.0` to confirm the published tarball is available, and ensure `contextRequest` and `contextResponse` are present—do not rely solely on the exit code.
4. Switch the CLI (teamem-ai/cli) `sessionStartRuntime` to use `contextResponse.parse()`, which should be done in a separate PR.

### Reasoning
- Local file, cross-repository workspace, Git URL, copied DTO, and dual-checkout CI fallbacks were deemed unsuitable. These methods could complicate the development and release process and lead to issues in dependency management.
- This change allows the server runtime to remain self-contained while enabling external consumers to receive the built npm artifact.
