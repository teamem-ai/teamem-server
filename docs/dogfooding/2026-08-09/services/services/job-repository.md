---
type: service
uuid: 67285d1e-c31c-4b2b-b1c3-cbd8820d23b9
path: services/job-repository
status: active
confidence: medium
title: Job Repository and enqueueCompilation Service
tags:
  - job
  - repository
  - service
  - idempotency
  - queue
  - pg-boss
  - lifecycle
  - policy
lastConfirmed: 2026-07-19T11:58:04.000Z
firstSeen: 2026-07-19T11:58:04.000Z
createdAt: 2026-08-09T13:28:54.104Z
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
    commitSha: 47f4612f497946b8c38f4fc506f711b9a95837b7
    path: prs/34.md
    at: 2026-07-19T11:58:04.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 8a3e10637505733fa31502bda2fc1f0d19e58417
    path: prs/51.md
    at: 2026-07-20T00:53:02.000Z
  - kind: repo_file
    repo: teamem-ai/teamem-server
    commitSha: 65ca06c86eef29a2120d0f431a7183ba7a8c6ecb
    path: prs/31.md
    at: 2026-07-19T09:47:51.000Z
---
The Job Repository implemented at `apps/server/src/db/repositories/jobs.ts` provides several capabilities for managing jobs with idempotent operations. Notable features include:

- **`createJob()`**: Allows for idempotent job creation by (project, kind, idempotencyKey). It supports replaying existing jobs based on the same key and handles conflicts when the same key is used with different job hashes.
- **`findJobByIdempotencyKey()`**: Enables users to look up jobs by their project, kind, and idempotency key.
- **`getJob()`**: Retrieves jobs with access control enforced by team ID, supporting scoped fetches.
- **`updateJobStatus()`**: Manages transitions in job lifecycle from queued to processing and final states while logging timestamps and sanitized error results.
- **`upsertJobEvent()`**: Updates or creates job events with retry safety and detailed tracking of job status and errors.
- **`getJobEvents()`**: Provides an ordered list of events related to jobs.

The `enqueueCompilation` service is responsible for creating persistent application-layer job records alongside pg-boss messages. It supports idempotent replay and provides safe crash recovery between database operations. This service ensures that job deliveries are managed effectively without duplication during crashes or retries.

## Key Features
- **Idempotent delivery**: Allows callers to set a primary key for pg-boss jobs, ensuring that repeated attempts do not create duplicate job records.
- **Crash recovery**: Handles potential lost messages during database to queue transitions by re-delivering messages without duplication.
- **Comprehensive testing**: Includes 13 integration tests confirming various scenarios such as successful enqueues, idempotent replays, and crash recoveries.

### pg-boss Lifecycle Policy
The `pg-boss lifecycle policy` defines explicit settings for queue behavior in our application. It includes configurations such as retries, delays, timeouts, and retention periods for job processing. Specifically, the default policy sets 3 retries with a 30-second delay and exponential backoff, a timeout of 10 minutes, a retention period of 14 days, and a completion retention of 7 days. This policy can be injected into the queue creation process, allowing customization while remaining backward-compatible.
