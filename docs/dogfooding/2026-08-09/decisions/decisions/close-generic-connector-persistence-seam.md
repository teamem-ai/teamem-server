---
type: decision
uuid: 20f30c7a-455d-4561-8978-b39ab4ca38b2
path: decisions/close-generic-connector-persistence-seam
status: active
confidence: high
title: Close the Generic Connector Persistence Seam
tags:
  - connector
  - decision
  - persistence
  - api
lastConfirmed: 2026-07-18T11:28:54.000Z
firstSeen: 2026-07-18T11:28:54.000Z
createdAt: 2026-08-09T13:29:45.642Z
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
    commitSha: 2080d9fa76dcce16b74d5baddfd6fadad90029be
    path: prs/5.md
    at: 2026-07-18T11:28:54.000Z
---
# Summary of Decision
The team decided to implement a new approach to handling connector persistence in the backend, particularly by introducing a generic `external` bucket to manage connectors that do not fit into the existing categories. This decision was made to avoid collisions between different providers that could share identifiers.

## Rationale
- **Reason for Choice**: Existing connector handling could lead to data collisions due to overlapping identifiers (e.g., delivery IDs or user IDs from different providers). By creating an `external` bucket and preserving the original identifiers, we can maintain unique constraints and ensure that data integrity is upheld.
- **Alternatives Considered**: The team assessed the risks of widening the TypeScript types from strict unions to more flexible types and chose this option to provide greater extensibility for future providers. However, we acknowledged the potential loss of exhaustiveness checking which may require external TypeScript consumers to add fallbacks.
- **Trade-offs**: While this change expands flexibility and supports additional providers, it also necessitates careful management of data integrity and TypeScript type handling to mitigate any breaking changes introduced to existing consumers.


## Impact Analysis
This decision is marked by a **breaking change** in TypeScript types, widening `Actor['provider']` from a literal union type to a broader string type. It is essential for all team members to review the impact on existing integrations and ensure compatibility moving forward.

## Next Steps
- Review the migration strategy and associated tests to ensure robust validation across all affected systems.
- Communicate these changes clearly to any external teams or stakeholders who might be impacted by the changes in the API contract.
