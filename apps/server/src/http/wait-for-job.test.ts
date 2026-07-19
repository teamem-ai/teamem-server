/**
 * waitForJob unit tests (DUA-154).
 *
 * Exercises the four contract scenarios — completed, failed, timed out, and
 * client-disconnect — using vitest fake timers so no test sleeps 30 real
 * seconds.  Repository calls (getJob, getJobEvents) are mocked at the module
 * level; the only goal is to verify the polling loop's decision logic and
 * its interaction with AbortSignal and the deadline.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { waitForJob } from './wait-for-job.js';
import type { WaitForJobOptions } from './wait-for-job.js';
import { projectScope } from '../auth/scope.js';

// ── Mock the jobs repository ────────────────────────────────────────────────
// We replace the two functions waitForJob imports so we control exactly what
// each poll sees.  The module under test is re-imported inside beforeEach so
// the mocked bindings are fresh.

vi.mock('../db/repositories/jobs.js', () => ({
  getJob: vi.fn(),
  getJobEvents: vi.fn(),
}));

import { getJob, getJobEvents } from '../db/repositories/jobs.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A ScopeContext that looks like a project-scoped key. */
function testScope() {
  return projectScope('team_testWait01', 'prj_testWait01');
}

function baseOptions(
  overrides: Partial<WaitForJobOptions> = {},
): WaitForJobOptions {
  return {
    db: null as unknown as WaitForJobOptions['db'], // not used by mocks
    scope: testScope(),
    jobId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timeoutMs: 30_000,
    pollIntervalMs: 500,
    ...overrides,
  };
}

/**
 * Advance fake time and flush one poll iteration.  Each call advances the
 * clock by `ms` and drains microtasks so the setTimeout callback fires once.
 * Unlike runAllTimersAsync, this does NOT exhaust all remaining timers.
 */
async function advanceOneTick(ms = 500): Promise<void> {
  vi.advanceTimersByTime(ms);
  // Let the setTimeout callback and its microtasks flush — but NOT
  // recursively exhaust new timers created by the next loop iteration.
  await Promise.resolve();
}

// ── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('waitForJob', () => {
  it('returns completed with conceptIds when the job reaches completed', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;
    const mockGetJobEvents = getJobEvents as ReturnType<typeof vi.fn>;

    // First poll: still queued → keep waiting.
    // Second poll: completed.
    mockGetJob
      .mockResolvedValueOnce({ status: 'queued', teamId: 'team_testWait01', projectId: 'prj_testWait01' })
      .mockResolvedValueOnce({ status: 'completed', teamId: 'team_testWait01', projectId: 'prj_testWait01' });

    mockGetJobEvents.mockResolvedValue([
      { conceptUuids: ['concept-aaa', 'concept-bbb'] },
    ]);

    const promise = waitForJob(baseOptions());

    // First tick: queued → no result yet.
    await advanceOneTick();
    // Second tick: completed.
    await advanceOneTick();

    const result = await promise;
    expect(result).toEqual({
      outcome: 'completed',
      conceptIds: ['concept-aaa', 'concept-bbb'],
    });
  });

  it('returns failed when the job reaches failed', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;

    mockGetJob
      .mockResolvedValueOnce({ status: 'processing', teamId: 't1', projectId: 'p1' })
      .mockResolvedValueOnce({ status: 'failed', teamId: 't1', projectId: 'p1' });

    const promise = waitForJob(baseOptions());
    await advanceOneTick();
    await advanceOneTick();

    const result = await promise;
    expect(result).toEqual({ outcome: 'failed' });
  });

  it('returns failed when the job is cancelled', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;

    mockGetJob
      .mockResolvedValueOnce({ status: 'queued', teamId: 't1', projectId: 'p1' })
      .mockResolvedValueOnce({ status: 'cancelled', teamId: 't1', projectId: 'p1' });

    const promise = waitForJob(baseOptions());
    await advanceOneTick();
    await advanceOneTick();

    const result = await promise;
    expect(result).toEqual({ outcome: 'failed' });
  });

  it('returns timed_out after the deadline', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;

    // Always return queued — the job never finishes.
    mockGetJob.mockResolvedValue({ status: 'queued', teamId: 't1', projectId: 'p1' });

    // Short timeout so the test finishes with a small number of ticks.
    const promise = waitForJob(baseOptions({ timeoutMs: 5_000 }));

    // Advance 10 ticks (5 000 ms) — exactly the deadline.
    for (let i = 0; i < 10; i++) {
      await advanceOneTick();
    }

    const result = await promise;
    expect(result).toEqual({ outcome: 'timed_out' });
  });

  it('returns aborted when the signal is aborted mid-wait', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;

    mockGetJob.mockResolvedValue({ status: 'queued', teamId: 't1', projectId: 'p1' });

    const controller = new AbortController();
    const promise = waitForJob(baseOptions({ signal: controller.signal }));

    // One tick passes normally.
    await advanceOneTick();

    // Client disconnects → abort the signal.
    controller.abort();

    // Next tick — should detect the aborted signal and exit.
    await advanceOneTick();

    const result = await promise;
    expect(result).toEqual({ outcome: 'aborted' });
  });

  it('returns aborted immediately when signal is already aborted', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;

    mockGetJob.mockResolvedValue({ status: 'queued', teamId: 't1', projectId: 'p1' });

    const controller = new AbortController();
    controller.abort(); // pre-aborted

    const promise = waitForJob(baseOptions({ signal: controller.signal }));

    // No time needs to advance — the first loop iteration sees the aborted
    // signal before the first setTimeout.
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toEqual({ outcome: 'aborted' });
  });

  it('retries on transient getJob errors and eventually succeeds', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;
    const mockGetJobEvents = getJobEvents as ReturnType<typeof vi.fn>;

    // First two polls throw (transient errors), third succeeds.
    mockGetJob
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ status: 'completed', teamId: 't1', projectId: 'p1' });

    mockGetJobEvents.mockResolvedValue([
      { conceptUuids: ['concept-zzz'] },
    ]);

    const promise = waitForJob(baseOptions());

    await advanceOneTick(); // error → retry
    await advanceOneTick(); // error → retry
    await advanceOneTick(); // success!

    const result = await promise;
    expect(result).toEqual({
      outcome: 'completed',
      conceptIds: ['concept-zzz'],
    });
  });

  it('aggregates conceptIds across all job events', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;
    const mockGetJobEvents = getJobEvents as ReturnType<typeof vi.fn>;

    mockGetJob.mockResolvedValue({ status: 'completed', teamId: 't1', projectId: 'p1' });
    mockGetJobEvents.mockResolvedValue([
      { conceptUuids: ['a', 'b'] },
      { conceptUuids: ['c'] },
      { conceptUuids: null }, // skipped/null event — filtered out
      { conceptUuids: [] }, // empty array — filtered out
    ]);

    const promise = waitForJob(baseOptions());
    await advanceOneTick();

    const result = await promise;
    expect(result).toEqual({
      outcome: 'completed',
      conceptIds: ['a', 'b', 'c'],
    });
  });

  it('does not poll getJobEvents when job fails (no concept IDs to fetch)', async () => {
    const mockGetJob = getJob as ReturnType<typeof vi.fn>;
    const mockGetJobEvents = getJobEvents as ReturnType<typeof vi.fn>;

    mockGetJob.mockResolvedValue({ status: 'failed', teamId: 't1', projectId: 'p1' });

    const promise = waitForJob(baseOptions());
    await advanceOneTick();

    const result = await promise;
    expect(result).toEqual({ outcome: 'failed' });
    expect(mockGetJobEvents).not.toHaveBeenCalled();
  });
});
