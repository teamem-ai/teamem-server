---
type: decision
uuid: 489a9e09-71f2-4932-a109-c02ce0680264
path: decisions/minimal-f1-structured-output
status: active
confidence: high
title: Wired Full F1 to F2 Compilation Pipeline and Minimal F1 Structured-Output Contract Decisions
tags:
  - f1
  - structured-output
  - decisions
  - llm
  - f1-f2
  - compilation
  - decision
  - extraction
  - prompt
  - specifications
lastConfirmed: 2026-07-19T01:03:42.000Z
firstSeen: 2026-07-19T01:03:42.000Z
createdAt: 2026-08-09T13:24:46.782Z
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
    commitSha: 787ca5c0fd30c57ddb9586a51fdeccf93dae75bd
    path: prs/21.md
    at: 2026-07-19T01:03:42.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 8734e4c662220a9da632387e22bdc09f086a91b9
    path: prs/93.md
    at: 2026-07-23T04:21:08.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 742fde4cf4409a8032abe666ff7052729f220182
    path: prs/76.md
    at: 2026-07-22T06:02:38.000Z
---
## Wired Full F1 to F2 Compilation Pipeline and Minimal F1 Structured-Output Contract Decisions

We decided to implement a complete F1 → F2 compilation pipeline in the compile handler to replace the previous M0 behavior of handling only F1 inputs with duplicate pages. This new approach allows for knowledge merging and ensures that existing concepts are appropriately updated or created based on recall candidates. Specifically, when candidates are found during F2 processing, we use the `decideMerge` function to determine if we should update a concept or create a new one if no candidates exist. This change enhances the data path's efficiency and correctness by enabling transactionally safe operations and proper handling of tenant scope throughout the process.

In relation to this implementation, we defined the minimal F1 structured-output contract and provider-neutral prompt for LLM-based concept extraction. Key decisions included: 1) Excluding `status` in the output since new concepts start as `active` per server logic, making status transitions a compiler responsibility rather than LLM output. 2) Employing `strictObject` everywhere to ensure that model-hallucinated keys fail at the schema boundary rather than being silently dropped, in line with our strict validation requirements. 3) Reusing `@teamem/schema` primitives to maintain consistency and avoid duplication.

## F1 Extraction Prompt Specifications

The F1 extraction prompt has been enhanced from its minimal version to a full specification. This includes:

- **Six Type Definitions**: These definitions are framed within the context of semantic roles, focusing on decision-making, warning traps, operational tasks, conventions, service identification, and conceptual understanding.
- **Type Conflict Priority Rules**: The hierarchy for resolving conflicts among the types is established as follows: `decision > gotcha > runbook > convention > service > concept`.
- **Three-tier Confidence Admission Gates**: There are three levels of confidence defined:
  - **High**: Claims supported by two or more independent sources or authoritative documentation.
  - **Medium**: Knowledge derived from a single clear source without contradiction.
  - **Low**: Instances that rely on inference, speculation, or weak signals.
- **Explicit Skip Criteria**: Clear guidelines are set for identifying mechanical or noisy events to avoid cluttering the knowledge database.
- **Structured Output Enforcement Guidance**: Recommendations for maintaining a clear structure in output, optimizing for efficiency, especially for cheaper models.

These enhancements aim to provide clarity and prevent redundancy, particularly addressing issues like the potential confusion from having duplicate `## Skip Criteria` sections embedded within segments of the prompt.  This knowledge is critical for understanding how knowledge extraction and evaluation processes should be handled within the team.
