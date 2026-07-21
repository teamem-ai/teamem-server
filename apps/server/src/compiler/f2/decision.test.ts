/**
 * F2 merge-decision structured output contract tests.
 *
 * Validates the F2 decision schema (decision.ts) against success paths,
 * failure paths, boundary/security counterexamples, and the red-line
 * "contradicts → disputed" rule.
 *
 * No database required — pure Zod validation tests.
 * No mocks — the schema IS the contract under test.
 */
import { describe, expect, it } from 'vitest';
import { f2Decision, f2Relationship, type F2Decision } from './decision.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function validDecision(
  overrides?: Partial<Record<string, unknown>>,
): F2Decision {
  return {
    relationship: 'confirms',
    targetConceptId: VALID_UUID,
    mergedTitle: 'Use Postgres for the primary datastore',
    mergedBody: '## Decision\n\nWe chose Postgres over MongoDB.\n\n### Rationale\n\n- Strong ACID guarantees\n- Mature ecosystem',
    resultStatus: 'active',
    ...overrides,
  } as F2Decision;
}

// ── Relationship value coverage (CLI acceptance: all four values pass) ──────

describe('f2Decision — relationship coverage (all four values pass)', () => {
  it('accepts relationship "confirms"', () => {
    const result = f2Decision.safeParse(
      validDecision({ relationship: 'confirms' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts relationship "extends"', () => {
    const result = f2Decision.safeParse(
      validDecision({ relationship: 'extends' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts relationship "contradicts" with resultStatus=disputed', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'contradicts',
        resultStatus: 'disputed',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts relationship "unrelated" with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'unrelated',
        targetConceptId: null,
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ── Success paths ────────────────────────────────────────────────────────────

describe('f2Decision — success paths', () => {
  it('accepts a valid confirms decision', () => {
    const result = f2Decision.safeParse(validDecision());
    expect(result.success).toBe(true);
  });

  it('accepts extends with existing concept UUID', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'extends',
        targetConceptId: VALID_UUID,
        mergedTitle: 'Expanded: Use Postgres',
        mergedBody: 'Updated body with new details.',
        resultStatus: 'active',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts contradicts with disputed status', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'contradicts',
        targetConceptId: VALID_UUID,
        mergedTitle: 'Reconsider Postgres for primary datastore',
        mergedBody: 'New evidence suggests MongoDB may be preferable.',
        resultStatus: 'disputed',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts unrelated with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'unrelated',
        targetConceptId: null,
        mergedTitle: 'New concept about CI pipeline',
        mergedBody: 'We use GitHub Actions for CI/CD.',
        resultStatus: 'active',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts confirms with a different valid concept status', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'confirms',
        resultStatus: 'active',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts extends with superseded status', () => {
    // Extending a superseded concept may revive it — the model decides.
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'extends',
        resultStatus: 'superseded',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts confirms with needs-review status', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'confirms',
        resultStatus: 'needs-review',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts complex markdown in mergedBody', () => {
    const result = f2Decision.safeParse(
      validDecision({
        mergedBody:
          '## Overview\n\nThis is a **bold** decision.\n\n```typescript\nconst x = 1;\n```\n\nSee [link](https://example.com) for details.',
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ── Red line: contradicts → resultStatus must be "disputed" ─────────────────

describe('f2Decision — red line: contradicts → disputed (not confidence cut)', () => {
  it('rejects contradicts with resultStatus "active"', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'contradicts',
        targetConceptId: VALID_UUID,
        resultStatus: 'active',
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      const resultStatusIssue = issues.find(
        (i) =>
          i.path.length === 1 &&
          i.path[0] === 'resultStatus',
      );
      expect(resultStatusIssue).toBeDefined();
      expect(resultStatusIssue?.message).toContain('disputed');
    }
  });

  it('rejects contradicts with resultStatus "superseded"', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'contradicts',
        targetConceptId: VALID_UUID,
        resultStatus: 'superseded',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects contradicts with resultStatus "needs-review"', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'contradicts',
        targetConceptId: VALID_UUID,
        resultStatus: 'needs-review',
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ── Unrelated → targetConceptId must be null ────────────────────────────────

describe('f2Decision — unrelated → targetConceptId must be null', () => {
  it('rejects unrelated with non-null targetConceptId', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'unrelated',
        targetConceptId: VALID_UUID,
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      const targetIssue = issues.find(
        (i) =>
          i.path.length === 1 &&
          i.path[0] === 'targetConceptId',
      );
      expect(targetIssue).toBeDefined();
      expect(targetIssue?.message).toContain('null');
    }
  });
});

// ── Non-unrelated → targetConceptId must not be null ────────────────────────

describe('f2Decision — non-unrelated → targetConceptId must not be null', () => {
  it('rejects confirms with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'confirms',
        targetConceptId: null,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects extends with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'extends',
        targetConceptId: null,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects contradicts with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      validDecision({
        relationship: 'contradicts',
        resultStatus: 'disputed',
        targetConceptId: null,
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ── Failure paths: unknown fields rejected (strict object) ──────────────────

describe('f2Decision — unknown field rejection (strictObject)', () => {
  it('rejects with extra field "uuid"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      uuid: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "evidence"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      evidence: [
        { kind: 'pr', ref: 'https://example.com', at: '2026-07-17T00:00:00.000Z' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "contributors"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      contributors: ['pri_01H'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "createdAt"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      createdAt: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "schemaVersion"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "aliases"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      aliases: ['old/path'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "supersedes"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      supersedes: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "firstSeen"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      firstSeen: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "lastConfirmed"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      lastConfirmed: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "updatedAt"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      updatedAt: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "actorProvenance"', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      actorProvenance: 'webhook_verified',
    });
    expect(result.success).toBe(false);
  });
});

// ── Failure paths: missing required fields ───────────────────────────────────

describe('f2Decision — missing required fields', () => {
  function omit(
    obj: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    const { [key]: _omitted, ...rest } = obj;
    void _omitted;
    return rest;
  }

  it('rejects without "relationship"', () => {
    const result = f2Decision.safeParse(
      omit(validDecision() as Record<string, unknown>, 'relationship'),
    );
    expect(result.success).toBe(false);
  });

  it('rejects without "targetConceptId"', () => {
    const result = f2Decision.safeParse(
      omit(validDecision() as Record<string, unknown>, 'targetConceptId'),
    );
    expect(result.success).toBe(false);
  });

  it('rejects without "mergedTitle"', () => {
    const result = f2Decision.safeParse(
      omit(validDecision() as Record<string, unknown>, 'mergedTitle'),
    );
    expect(result.success).toBe(false);
  });

  it('rejects without "mergedBody"', () => {
    const result = f2Decision.safeParse(
      omit(validDecision() as Record<string, unknown>, 'mergedBody'),
    );
    expect(result.success).toBe(false);
  });

  it('rejects without "resultStatus"', () => {
    const result = f2Decision.safeParse(
      omit(validDecision() as Record<string, unknown>, 'resultStatus'),
    );
    expect(result.success).toBe(false);
  });
});

// ── Failure paths: invalid values ────────────────────────────────────────────

describe('f2Decision — invalid values', () => {
  it('rejects unknown relationship value', () => {
    const result = f2Decision.safeParse(
      validDecision({ relationship: 'invalid_relation' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects unknown resultStatus value', () => {
    const result = f2Decision.safeParse(
      validDecision({ resultStatus: 'deleted' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID format for targetConceptId', () => {
    const result = f2Decision.safeParse(
      validDecision({ targetConceptId: 'not-a-uuid' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects empty mergedTitle', () => {
    const result = f2Decision.safeParse(
      validDecision({ mergedTitle: '' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects empty mergedBody', () => {
    const result = f2Decision.safeParse(
      validDecision({ mergedBody: '' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects non-string relationship', () => {
    const result = f2Decision.safeParse(
      validDecision({ relationship: 123 }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects non-string mergedTitle', () => {
    const result = f2Decision.safeParse(
      validDecision({ mergedTitle: null }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects non-string mergedBody', () => {
    const result = f2Decision.safeParse(
      validDecision({ mergedBody: 42 }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects targetConceptId as string "null"', () => {
    const result = f2Decision.safeParse(
      validDecision({ targetConceptId: 'null' }),
    );
    expect(result.success).toBe(false);
  });
});

// ── Boundary / security counterexamples ──────────────────────────────────────

describe('f2Decision — boundary / security counterexamples', () => {
  it('rejects empty object', () => {
    const result = f2Decision.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = f2Decision.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('rejects array', () => {
    const result = f2Decision.safeParse([]);
    expect(result.success).toBe(false);
  });

  it('rejects undefined', () => {
    const result = f2Decision.safeParse(undefined);
    expect(result.success).toBe(false);
  });

  it('accepts mergedTitle at exactly 500 characters', () => {
    const title = 'A'.repeat(500);
    const result = f2Decision.safeParse(validDecision({ mergedTitle: title }));
    expect(result.success).toBe(true);
  });

  it('rejects mergedTitle exceeding 500 characters', () => {
    const title = 'A'.repeat(501);
    const result = f2Decision.safeParse(validDecision({ mergedTitle: title }));
    expect(result.success).toBe(false);
  });

  it('rejects model-invented UUID as extra field (not targetConceptId)', () => {
    // The model might try to put a uuid at top level, which should fail
    const result = f2Decision.safeParse({
      ...validDecision(),
      uuid: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented confidence as extra field (belongs to concept, not decision)', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      confidence: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented path as extra field', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      path: 'decisions/use-postgres',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented type as extra field', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      type: 'decision',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented tags as extra field', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      tags: ['database'],
    });
    expect(result.success).toBe(false);
  });
});

// ── f2Relationship standalone schema ───────────────────────────────────────

describe('f2Relationship — standalone enum', () => {
  it('accepts all four values', () => {
    for (const val of ['confirms', 'extends', 'contradicts', 'unrelated']) {
      expect(f2Relationship.safeParse(val).success).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(f2Relationship.safeParse('conflicts').success).toBe(false);
    expect(f2Relationship.safeParse('duplicate').success).toBe(false);
    expect(f2Relationship.safeParse('').success).toBe(false);
  });
});

// ── resultStatus coverage: all four concept statuses accepted (when valid) ──

describe('f2Decision — resultStatus coverage', () => {
  const statuses = ['active', 'superseded', 'disputed', 'needs-review'] as const;

  for (const status of statuses) {
    if (status === 'disputed') {
      // disputed is valid in general, but for confirms it's unusual —
      // the schema allows it; the compiler may have its own rules.
      it(`accepts confirms with resultStatus "${status}"`, () => {
        const result = f2Decision.safeParse(
          validDecision({ relationship: 'confirms', resultStatus: status }),
        );
        expect(result.success).toBe(true);
      });
    } else {
      it(`accepts confirms with resultStatus "${status}"`, () => {
        const result = f2Decision.safeParse(
          validDecision({ relationship: 'confirms', resultStatus: status }),
        );
        expect(result.success).toBe(true);
      });
    }
  }
});

// ── Schema stability: strictObject rejects any unknown key ─────────────────

describe('f2Decision — strictObject integrity', () => {
  it('rejects otherwise-valid object with one extra key', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      extraKey: 'should fail',
    });
    expect(result.success).toBe(false);
  });

  it('rejects multiple extra keys', () => {
    const result = f2Decision.safeParse({
      ...validDecision(),
      field1: true,
      field2: 42,
    });
    expect(result.success).toBe(false);
  });
});
