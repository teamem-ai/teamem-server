---
type: service
uuid: 5167d068-e8f6-4798-aad5-b5d820f90a59
path: services/github-connector
status: active
confidence: medium
title: GitHub Connector with Smoke Test Integration and Pull Request Webhook Normalizer
tags:
  - github
  - connector
  - webhook
  - smoke-test
  - qa
  - normalization
  - event-processing
lastConfirmed: 2026-07-20T02:56:08.000Z
firstSeen: 2026-07-20T02:56:08.000Z
createdAt: 2026-08-09T13:22:10.783Z
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
    commitSha: 07b80685786067aa63e0071b33254aa4a2b3b42a
    path: prs/55.md
    at: 2026-07-20T02:56:08.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: fa5d0805e0d8f688ffa3b9840155ff2cf2b9f3ce
    path: prs/41.md
    at: 2026-07-19T23:16:31.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: b1c4ac77cc93962c5cc78f82439aad72d9b1d681
    path: prs/27.md
    at: 2026-07-19T07:13:27.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 945814abb26232cf6400f643c28a4a99db7dd1c5
    path: prs/28.md
    at: 2026-07-19T08:16:52.000Z
---
The **GitHub Connector** is a service that implements the `Connector` interface for handling events from GitHub. It handles signing verification, dispatches events to corresponding normalizers for different event types (such as push, pull requests, issues, and comments), and produces an array of normalized events. Unsupported events will return an empty array. This connector is registered at startup when the `TEAMEM_GITHUB_WEBHOOK_SECRET` is configured, and it exposes a webhook HTTP route at `POST /v1/connectors/:connectorKind/webhook?project=<prj_id>`, which processes raw event bodies and enqueues jobs without requiring a Bearer token authentication, as the webhook signature serves as the only form of authorization.

Additionally, the **GitHub Pull Request Webhook Normalizer** is a pure function that maps raw GitHub `pull_request` webhook payloads into a `NormalizedEvent`, which adheres to the connector producer contract defined in `connectors/registry.ts`. It supports specific actions such as `opened`, `edited`, `synchronize`, `closed`, and `reopened`, while explicitly ignoring unsupported actions. The normalizer preserves original facts and maintains a stable identity for pull requests using a specific `externalId` structure. It ensures that the normalized events are complete and never half-fabricated, thereby providing a reliable representation of the webhook data.

In addition, the team decided to implement the DUA-146 comment normalizer for `issue_comment`, `pull_request_review`, and `pull_request_review_comment` webhook deliveries. This decision was made to produce a `NormalizedEvent` classified as the frozen `github_pr_comment` source kind. The rationale behind this decision includes producing stable identifiers for comments via `itemKey` / `externalId`, ensuring that an immutable permalink is provided, with a preference for verified `html_url` and a deterministic fallback, preserving the parent PR/issue reference within the payload, and maintaining raw action, actor, and provider timestamps as per N2/N8 guidelines, while ensuring that all actors are accurately identified without fabrication.

The team evaluated other normalization strategies but determined that producing the `NormalizedEvent` with the stated parameters would lead to better consistency and traceability in handling GitHub event comments. Choosing this normalizer means accepting the complexity of maintaining stability in URLs and extracted timestamps but greatly increases the reliability of event data processing.

Additionally, we have decided to add a smoke test script for GitHub webhooks as part of the QA process. This script automates the creation of real GitHub events (such as push, PR, issue, and PR review comment) in a test repository, enabling verification of the normalization and persistence of these events through teamem's connector storage against a live PostgreSQL database. The smoke test will enhance confidence in the webhook integrations before deploying to production. This approach was favored over manual testing, which would not provide the same level of coverage and reliability. The implementation of this smoke test requires initial setup and added complexity in test infrastructure, but the benefits of early detection of issues justify this addition to our QA suite.
