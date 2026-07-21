/**
 * F2 merge-decision structured output contract tests.
 *
 * Validates the F2 decision schema (decision.ts) against success paths,
 * failure paths, boundary/security counterexamples, the red-line
 * "contradicts → disputed" rule, and TypeScript narrowing via
 * discriminated union.
 *
 * No database required — pure Zod validation tests.
 * No mocks — the schema IS the contract under test.
 */
import { describe, expect, it } from 'vitest';
import { f2Decision, f2Relationship, type F2Decision } from './decision.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function confirms(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    relationship: 'confirms',
    targetConceptId: VALID_UUID,
    mergedTitle: 'Use Postgres for the primary datastore',
    mergedBody: '## Decision\n\nWe chose Postgres over MongoDB.\n\n### Rationale\n\n- Strong ACID guarantees\n- Mature ecosystem',
    resultStatus: 'active',
    ...overrides,
  };
}

// ── Relationship value coverage (CLI acceptance: all four values pass) ──────

describe('f2Decision — relationship coverage (all four values pass)', () => {
  it('accepts relationship "confirms"', () => {
    const result = f2Decision.safeParse(confirms());
    expect(result.success).toBe(true);
  });

  it('accepts relationship "extends"', () => {
    const result = f2Decision.safeParse(confirms({ relationship: 'extends' }));
    expect(result.success).toBe(true);
  });

  it('accepts relationship "contradicts" with resultStatus=disputed', () => {
    const result = f2Decision.safeParse(
      confirms({
        relationship: 'contradicts',
        resultStatus: 'disputed',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts relationship "unrelated" with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      confirms({
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
    const result = f2Decision.safeParse(confirms());
    expect(result.success).toBe(true);
  });

  it('accepts extends with existing concept UUID', () => {
    const result = f2Decision.safeParse(
      confirms({
        relationship: 'extends',
        mergedTitle: 'Expanded: Use Postgres',
        mergedBody: 'Updated body with new details.',
        resultStatus: 'active',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts contradicts with disputed status', () => {
    const result = f2Decision.safeParse(
      confirms({
        relationship: 'contradicts',
        mergedTitle: 'Reconsider Postgres for primary datastore',
        mergedBody: 'New evidence suggests MongoDB may be preferable.',
        resultStatus: 'disputed',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts unrelated with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      confirms({
        relationship: 'unrelated',
        targetConceptId: null,
        mergedTitle: 'New concept about CI pipeline',
        mergedBody: 'We use GitHub Actions for CI/CD.',
        resultStatus: 'active',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts confirms with superseded status', () => {
    const result = f2Decision.safeParse(
      confirms({ resultStatus: 'superseded' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts confirms with needs-review status', () => {
    const result = f2Decision.safeParse(
      confirms({ resultStatus: 'needs-review' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts complex markdown in mergedBody', () => {
    const result = f2Decision.safeParse(
      confirms({
        mergedBody:
          '## Overview\n\nThis is a **bold** decision.\n\n```typescript\nconst x = 1;\n```\n\nSee [link](https://example.com) for details.',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts mergedBody at exactly 50000 characters', () => {
    const body = 'A'.repeat(50_000);
    expect(body.length).toBe(50_000);
    const result = f2Decision.safeParse(confirms({ mergedBody: body }));
    expect(result.success).toBe(true);
  });
});

// ── Red line: contradicts → resultStatus must be "disputed" ─────────────────
//    Encoded as z.literal('disputed') on the contradicts branch, so
//    non-disputed statuses fail at the literal level (not via superRefine).

describe('f2Decision — red line: contradicts → disputed (encoded as literal)', () => {
  it('rejects contradicts with resultStatus "active"', () => {
    const result = f2Decision.safeParse(
      confirms({ relationship: 'contradicts', resultStatus: 'active' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects contradicts with resultStatus "superseded"', () => {
    const result = f2Decision.safeParse(
      confirms({ relationship: 'contradicts', resultStatus: 'superseded' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects contradicts with resultStatus "needs-review"', () => {
    const result = f2Decision.safeParse(
      confirms({ relationship: 'contradicts', resultStatus: 'needs-review' }),
    );
    expect(result.success).toBe(false);
  });
});

// ── Unrelated → targetConceptId must be null (encoded as z.null()) ─────────

describe('f2Decision — unrelated → targetConceptId must be null', () => {
  it('rejects unrelated with a UUID string as targetConceptId', () => {
    // z.null() only accepts JavaScript null, not a UUID string
    const result = f2Decision.safeParse(
      confirms({ relationship: 'unrelated', targetConceptId: VALID_UUID }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects unrelated with arbitrary string as targetConceptId', () => {
    const result = f2Decision.safeParse(
      confirms({ relationship: 'unrelated', targetConceptId: 'some-string' }),
    );
    expect(result.success).toBe(false);
  });
});

// ── Non-unrelated → targetConceptId must be a valid UUID (non-null) ────────

describe('f2Decision — non-unrelated → targetConceptId must be a valid UUID', () => {
  it('rejects confirms with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      confirms({ targetConceptId: null }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects extends with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      confirms({ relationship: 'extends', targetConceptId: null }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects contradicts with null targetConceptId', () => {
    const result = f2Decision.safeParse(
      confirms({
        relationship: 'contradicts',
        resultStatus: 'disputed',
        targetConceptId: null,
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ── Failure paths: unknown fields rejected (strict object on every branch) ──

describe('f2Decision — unknown field rejection (strictObject per branch)', () => {
  it('rejects with extra field "uuid"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      uuid: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "evidence"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      evidence: [
        { kind: 'pr', ref: 'https://example.com', at: '2026-07-17T00:00:00.000Z' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "contributors"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      contributors: ['pri_01H'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "createdAt"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      createdAt: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "schemaVersion"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "aliases"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      aliases: ['old/path'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "supersedes"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      supersedes: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "firstSeen"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      firstSeen: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "lastConfirmed"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      lastConfirmed: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "updatedAt"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      updatedAt: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects with extra field "actorProvenance"', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      actorProvenance: 'webhook_verified',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields on unrelated branch', () => {
    const result = f2Decision.safeParse({
      relationship: 'unrelated',
      targetConceptId: null,
      mergedTitle: 'Title',
      mergedBody: 'Body',
      resultStatus: 'active',
      uuid: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields on contradicts branch', () => {
    const result = f2Decision.safeParse({
      relationship: 'contradicts',
      targetConceptId: VALID_UUID,
      mergedTitle: 'Title',
      mergedBody: 'Body',
      resultStatus: 'disputed',
      confidence: 'low',
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
    const result = f2Decision.safeParse(omit(confirms(), 'relationship'));
    expect(result.success).toBe(false);
  });

  it('rejects without "targetConceptId"', () => {
    const result = f2Decision.safeParse(omit(confirms(), 'targetConceptId'));
    expect(result.success).toBe(false);
  });

  it('rejects without "mergedTitle"', () => {
    const result = f2Decision.safeParse(omit(confirms(), 'mergedTitle'));
    expect(result.success).toBe(false);
  });

  it('rejects without "mergedBody"', () => {
    const result = f2Decision.safeParse(omit(confirms(), 'mergedBody'));
    expect(result.success).toBe(false);
  });

  it('rejects without "resultStatus"', () => {
    const result = f2Decision.safeParse(omit(confirms(), 'resultStatus'));
    expect(result.success).toBe(false);
  });
});

// ── Failure paths: invalid values ────────────────────────────────────────────

describe('f2Decision — invalid values', () => {
  it('rejects unknown relationship value', () => {
    const result = f2Decision.safeParse(
      confirms({ relationship: 'invalid_relation' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects unknown resultStatus on confirms branch', () => {
    const result = f2Decision.safeParse(
      confirms({ resultStatus: 'deleted' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID format for targetConceptId', () => {
    const result = f2Decision.safeParse(
      confirms({ targetConceptId: 'not-a-uuid' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects empty mergedTitle', () => {
    const result = f2Decision.safeParse(confirms({ mergedTitle: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects empty mergedBody', () => {
    const result = f2Decision.safeParse(confirms({ mergedBody: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string relationship', () => {
    const result = f2Decision.safeParse(confirms({ relationship: 123 }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string mergedTitle', () => {
    const result = f2Decision.safeParse(confirms({ mergedTitle: null }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string mergedBody', () => {
    const result = f2Decision.safeParse(confirms({ mergedBody: 42 }));
    expect(result.success).toBe(false);
  });

  it('rejects targetConceptId as string "null" on confirms', () => {
    const result = f2Decision.safeParse(
      confirms({ targetConceptId: 'null' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects mergedBody exceeding 50000 characters', () => {
    const body = 'A'.repeat(50_001);
    expect(body.length).toBe(50_001);
    const result = f2Decision.safeParse(confirms({ mergedBody: body }));
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
    const result = f2Decision.safeParse(confirms({ mergedTitle: title }));
    expect(result.success).toBe(true);
  });

  it('rejects mergedTitle exceeding 500 characters', () => {
    const title = 'A'.repeat(501);
    const result = f2Decision.safeParse(confirms({ mergedTitle: title }));
    expect(result.success).toBe(false);
  });

  it('rejects model-invented UUID as extra field (not targetConceptId)', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      uuid: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented confidence as extra field (belongs to concept, not decision)', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      confidence: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented path as extra field', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      path: 'decisions/use-postgres',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented type as extra field', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      type: 'decision',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented tags as extra field', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
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
    it(`accepts confirms with resultStatus "${status}"`, () => {
      const result = f2Decision.safeParse(
        confirms({ resultStatus: status }),
      );
      expect(result.success).toBe(true);
    });
  }
});

// ── Schema stability: strictObject rejects any unknown key ─────────────────

describe('f2Decision — strictObject integrity', () => {
  it('rejects otherwise-valid object with one extra key', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      extraKey: 'should fail',
    });
    expect(result.success).toBe(false);
  });

  it('rejects multiple extra keys', () => {
    const result = f2Decision.safeParse({
      ...confirms(),
      field1: true,
      field2: 42,
    });
    expect(result.success).toBe(false);
  });
});

// ── Type narrowing: discriminated union narrows per branch ──────────────────

describe('f2Decision — discriminated union type narrowing', () => {
  it('narrows targetConceptId to string on confirms', () => {
    const result = f2Decision.parse(confirms());
    if (result.relationship === 'confirms') {
      // TypeScript narrows: targetConceptId is string
      const id: string = result.targetConceptId;
      expect(id).toBe(VALID_UUID);
    } else {
      throw new Error('Expected confirms');
    }
  });

  it('narrows targetConceptId to string on extends', () => {
    const result = f2Decision.parse(confirms({ relationship: 'extends' }));
    if (result.relationship === 'extends') {
      const id: string = result.targetConceptId;
      expect(id).toBe(VALID_UUID);
    } else {
      throw new Error('Expected extends');
    }
  });

  it('narrows targetConceptId to string on contradicts', () => {
    const result = f2Decision.parse(
      confirms({ relationship: 'contradicts', resultStatus: 'disputed' }),
    );
    if (result.relationship === 'contradicts') {
      const id: string = result.targetConceptId;
      expect(id).toBe(VALID_UUID);
      // resultStatus is narrowed to the literal 'disputed'
      const status: 'disputed' = result.resultStatus;
      expect(status).toBe('disputed');
    } else {
      throw new Error('Expected contradicts');
    }
  });

  it('narrows targetConceptId to null on unrelated', () => {
    const result = f2Decision.parse(
      confirms({ relationship: 'unrelated', targetConceptId: null }),
    );
    if (result.relationship === 'unrelated') {
      const id: null = result.targetConceptId;
      expect(id).toBeNull();
    } else {
      throw new Error('Expected unrelated');
    }
  });

  it('exhaustive check compiles with all four branches', () => {
    function handle(d: F2Decision): string {
      switch (d.relationship) {
        case 'confirms':
          return `confirms ${d.targetConceptId}: ${d.mergedTitle}`;
        case 'extends':
          return `extends ${d.targetConceptId}: ${d.mergedTitle}`;
        case 'contradicts':
          // d.resultStatus is 'disputed', d.targetConceptId is string
          return `contradicts ${d.targetConceptId} (${d.resultStatus}): ${d.mergedTitle}`;
        case 'unrelated':
          // d.targetConceptId is null
          return `unrelated (new): ${d.mergedTitle}`;
      }
    }
    const result = handle(f2Decision.parse(confirms()));
    expect(result).toContain('confirms');
  });
});
