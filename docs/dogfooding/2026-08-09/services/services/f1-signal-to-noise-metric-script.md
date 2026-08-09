---
type: service
uuid: 4b7b0f8c-284a-4327-8195-99fb1497dcbd
path: services/f1-signal-to-noise-metric-script
status: active
confidence: medium
title: F1 Signal-to-Noise Metric Script
tags:
  - f1
  - signal-to-noise
  - script
  - metrics
lastConfirmed: 2026-07-22T07:39:16.000Z
firstSeen: 2026-07-22T07:39:16.000Z
createdAt: 2026-08-09T13:24:10.109Z
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
    commitSha: 51b40d0d739d5acb41fb468c5eb039ce2284216f
    path: prs/84.md
    at: 2026-07-22T07:39:16.000Z
---
# F1 Signal-to-Noise Metric Script

**m1:f1-signal** - This script calculates the signal-to-noise ratio from a batch of events processed through the F1 pipeline. The script works in two modes: with a provider and without a provider.

## Functionality
- **With provider**: The script executes a prefilter followed by a structured LLM extraction process, generating a JSON report that includes counted outcomes for extract and skip actions, type distributions, confidence distributions, and latency statistics.
- **Without provider**: Outputs a status indicating that processing was skipped (e.g., `{"status":"skipped","reason":"..."}`) and does not produce any counts.

## Key Features
- Exports the function `runSignalToNoise()` for programmatic use.
- Handles schema validation failures by counting them as failures, ensuring no silent downgrades occur.

## Related Files
- **app/server/scripts/m1-f1-signal.ts**: Contains core logic for the signal-to-noise metric pipeline, responsible for event processing and report building.
- **app/server/src/compiler/f1/signal-to-noise.f1.test.ts**: Contains acceptance tests to ensure that provider resolution and fixture loading operate correctly, along with validation for prefilter outcomes and report structures.

This script is crucial for measuring data quality and processing efficiency within our event-handling framework.
