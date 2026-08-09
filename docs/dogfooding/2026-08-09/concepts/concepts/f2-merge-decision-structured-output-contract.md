---
type: concept
uuid: 24c032ac-fc8f-40fb-96ef-6d9a26a69ddd
path: concepts/f2-merge-decision-structured-output-contract
status: active
confidence: high
title: F2 Merge-Decision Structured Output Contract
tags:
  - merge-decision
  - zod-schema
  - llm
  - team-knowledge
  - adapter
  - F2
  - decision
lastConfirmed: 2026-07-21T23:30:15.000Z
firstSeen: 2026-07-21T23:30:15.000Z
createdAt: 2026-08-09T13:27:51.458Z
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
    commitSha: 517db7c980053031ef3e84f47064ebe9383d11d1
    path: prs/70.md
    at: 2026-07-21T23:30:15.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: bba2e3788bea23a3d884b6a786c44086562c5ed1
    path: prs/79.md
    at: 2026-07-22T05:14:42.000Z
---
# F2 Merge-Decision Structured Output Contract

The F2 merge-decision structured output contract defines the Zod schema that LLM (Language Model) providers will target when deciding the relationship of new knowledge to existing concepts. This schema is crucial for maintaining the integrity and accuracy of knowledge extracted by the team. The key components of the schema are:

- **relationship**: This is a four-value discriminator indicating the relationship between knowledge items. Possible values are `confirms`, `extends`, `contradicts`, or `unrelated`.
- **targetConceptId**: This is the UUID of the target concept. It should be `null` when the relationship is `unrelated`.
- **mergedTitle** and **mergedBody**: These fields contain the rewritten, evidence-merged text. 
- **resultStatus**: This indicates the status of the concept after the merge. It plays a pivotal role in the validation process.

## Decision for F2 Strong-Model Merge-Decision Adapter

We decided to implement the `decideMerge(newConcept, candidates)` function as the F2 strong-model merge-decision adapter to enhance our concept validation process. This function integrates with a strong LLM, which receives a new concept alongside existing candidates, and returns a validated merge decision formatted according to the F2-01 JSON Schema. The decision was driven by our need for more robust, decision-making capabilities in the platform. The implementation includes additional validation and error handling to enforce schema correctness and prevent payload leakage into logs. Importantly, a secondary Zod validation was added to ensure 'defense in depth' against erroneous data parsing.

The changes also enforce strict conditions on the `resultStatus` variable across different relationship branches within the decision model to ensure semantic consistency in how concepts are flagged as disputed only when evidence contradicts.

### Safety Enforcements
There are specific safety enforcements via `.superRefine` in the schema:
- If contradictory evidence is present, the `resultStatus` must be `"disputed"`.
- For `unrelated` relationships, `targetConceptId` must be null.
- For relationships of types `confirms`, `extends`, or `contradicts`, `targetConceptId` must not be null.
- The schema rejects any model-hallucinated server-owned fields using `z.strictObject`.

This contract ensures high fidelity and correct categorization of decision outputs as new data is processed, thereby facilitating future knowledge extraction operations effectively.
