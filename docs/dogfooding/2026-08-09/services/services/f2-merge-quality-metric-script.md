---
type: service
uuid: c7603753-3f17-4ae4-9272-f1486894da16
path: services/f2-merge-quality-metric-script
status: active
confidence: medium
title: F2 Merge Quality Metric Script
tags:
  - quality
  - metrics
  - f2-merging
lastConfirmed: 2026-07-23T04:55:42.000Z
firstSeen: 2026-07-23T04:55:42.000Z
createdAt: 2026-08-09T13:28:05.215Z
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
    commitSha: 5523da3b85a6546fc1244314bfb30b03c9fb9a9f
    path: prs/97.md
    at: 2026-07-23T04:55:42.000Z
---
The `m1-f2-quality.ts` script is a standalone script that computes F2 merge-quality metrics from the real database data. It analyzes concept pages and compilation results in the database to compute three key metrics: wrong-attribution rate, duplicate-page rate, and page-count growth curve. It connects to a PostgreSQL database with specific queries and has various behaviors depending on the availability of embedding clients.
