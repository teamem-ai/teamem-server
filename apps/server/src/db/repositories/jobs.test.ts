/**
 * Unit tests for the Job Repository (DUA-179).
 *
 * Tests pure logic: error types and any functions that can be tested
 * without a database connection.
 */
import { describe, expect, it } from 'vitest';
import { IdempotencyConflictError } from './jobs.js';

describe('IdempotencyConflictError', () => {
  it('has the correct name and message', () => {
    const err = new IdempotencyConflictError(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(err.name).toBe('IdempotencyConflictError');
    expect(err.message).toBe(
      'idempotency_conflict: same key, different payload hash',
    );
  });

  it('exposes the existing job ID for caller redirection', () => {
    const jobId = '00000000-0000-4000-8000-000000000001';
    const err = new IdempotencyConflictError(jobId);
    expect(err.existingJobId).toBe(jobId);
  });

  it('is an instance of Error', () => {
    const err = new IdempotencyConflictError(
      '00000000-0000-4000-8000-000000000002',
    );
    expect(err).toBeInstanceOf(Error);
  });
});
