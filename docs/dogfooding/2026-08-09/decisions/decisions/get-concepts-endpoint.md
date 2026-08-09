---
type: decision
uuid: 47a4c078-9c46-47ce-9f63-84c3f638b177
path: decisions/get-concepts-endpoint
status: active
confidence: medium
title: Design Decisions for GET /v1/concepts Endpoint Implementation
tags:
  - api
  - concepts
  - design
  - decisions
lastConfirmed: 2026-07-20T03:51:08.000Z
firstSeen: 2026-07-20T03:51:08.000Z
createdAt: 2026-08-09T13:29:01.683Z
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
    commitSha: 599bf5b66678203b9a7dfc2580dc5dd0ce2521a5
    path: prs/60.md
    at: 2026-07-20T03:51:08.000Z
---
The implementation of the `GET /v1/concepts` endpoint included several design decisions that were made during development:

- **Sort Order**: Results are sorted by `last_confirmed DESC, uuid ASC` to comply with contract Q10 for cursor indexing of concepts.
- **Filtering Mechanism**: Tags are filtered using a GIN index (`concepts_tags_gin`), while contributors' filtering utilizes a subquery on `concept_contributors_filter_idx`.
- **Cursor Implementation**: A composite cursor `(last_confirmed, uuid)` was established, coupled with a SHA-256 `filterHash` to safeguard against filter changes during pagination.
- **Error Handling**: Any unknown query parameters (such as `q=`) will trigger a 400 response, ensuring explicit rejection rather than silent ignoring of invalid inputs.
- **Scope Enforcement**: Each query requires `team_id + project_id`, and cross-team access is managed to return a 404 status for anti-enumeration purposes.

These decisions were made to enhance the functionality, security, and usability of the endpoint, ensuring it meets both team requirements and performance demands.
