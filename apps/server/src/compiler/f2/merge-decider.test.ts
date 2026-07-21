/**
 * F2 merge-decider unit tests (M1-F2-03).
 *
 * Exercises the full {@link decideMerge} function against a fake {@link LlmClient}
 * (the only mock permitted per engineering red lines). The fake client runs
 * the real Zod re-validation path — no network, no real keys, but the same
 * schema enforcement as production.
 *
 * Covers:
 *  - CLI acceptance step 1: valid decision → parsed; malformed JSON → rejected
 *  - CLI acceptance step 2: contradicts → disputed status enforced
 *  - All four relationship branches: confirms, extends, contradicts, unrelated
 *  - Provider error propagation: timeout, http_error, provider_error
 *  - Schema validation failure (malformed output from strong model)
 *  - Boundary: empty candidates, single candidate, many candidates
 *  - Security: model-invented fields rejected by strictObject
 *  - Prompt construction: verify the fake client receives the right schema
 */
import { describe, expect, it } from 'vitest';

import { decideMerge } from './merge-decider.js';
import type {
  CandidateConceptSummary,
  MergeDeciderDeps,
  NewConceptInput,
} from './merge-decider.js';
import {
  f2Decision,
  type F2Decision,
} from './decision.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../../llm/types.js';
import { LlmError } from '../../llm/types.js';

// ── Test fixtures ───────────────────────────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';
const VALID_UUID_3 = '770e8400-e29b-41d4-a716-446655440002';

/** A realistic new concept (F1-extracted). */
function newConcept(overrides?: Partial<NewConceptInput>): NewConceptInput {
  return {
    type: 'decision',
    title: 'Use Postgres for the primary datastore',
    body: '## Decision\n\nWe chose Postgres over MongoDB for the primary datastore.\n\n### Rationale\n\n- Strong ACID guarantees\n- Mature ecosystem\n- Better tooling support',
    path: 'decisions/use-postgres',
    tags: ['database', 'postgres'],
    confidence: 'high',
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#42',
    ...overrides,
  };
}

function candidate(uuid: string, overrides?: Partial<CandidateConceptSummary>): CandidateConceptSummary {
  return {
    uuid,
    type: 'decision',
    status: 'active',
    title: 'Use Postgres for the main datastore',
    body: '## Decision\n\nWe chose Postgres.\n\n### Rationale\n\n- ACID compliance',
    path: 'decisions/use-postgres',
    tags: ['database', 'postgres'],
    evidenceSummary: ['commit: https://github.com/teamem-ai/teamem/commit/abc1234'],
    ...overrides,
  };
}

// ── Fake LlmClient builders ─────────────────────────────────────────────────

/** A canned {@link F2Decision} for tests. */
function cannedConfirm(): F2Decision {
  return {
    relationship: 'confirms',
    targetConceptId: VALID_UUID,
    mergedTitle: 'Use Postgres for the primary datastore',
    mergedBody: '## Decision\n\nWe chose Postgres over MongoDB for the primary datastore.\n\n### Rationale\n\n- Strong ACID guarantees\n- Mature ecosystem\n- Better tooling support\n\n### Evidence\n\n- PR #42: teamem-ai/teamem',
    resultStatus: 'active',
  };
}

function cannedExtend(): F2Decision {
  return {
    relationship: 'extends',
    targetConceptId: VALID_UUID,
    mergedTitle: 'Use Postgres for the primary datastore — with connection pooling',
    mergedBody: '## Decision\n\nWe chose Postgres. Connection pooling via PgBouncer is now part of the standard setup.\n\n### Rationale\n\n- ACID compliance\n- Connection pooling reduces overhead',
    resultStatus: 'active',
  };
}

function cannedContradict(): F2Decision {
  return {
    relationship: 'contradicts',
    targetConceptId: VALID_UUID,
    mergedTitle: 'Reconsider Postgres for the primary datastore',
    mergedBody: '## Conflict\n\n**Original claim**: We chose Postgres.\n\n**New evidence**: MongoDB may be a better fit for the document-heavy workload.\n\n### Resolution needed\n\nThe team should discuss and resolve the conflict.',
    resultStatus: 'disputed',
  };
}

function cannedUnrelated(): F2Decision {
  return {
    relationship: 'unrelated',
    targetConceptId: null,
    mergedTitle: 'New CI pipeline setup',
    mergedBody: '## Decision\n\nWe use GitHub Actions for CI/CD.\n\n### Pipeline\n\n- Lint\n- Typecheck\n- Test\n- Build',
    resultStatus: 'active',
  };
}

/**
 * Create a fake {@link LlmClient} that returns a pre-baked decision.
 * The fake validates against the real f2Decision schema, so test authors
 * get immediate feedback if the canned output is invalid.
 */
function fakeLlmClient(canned: F2Decision): LlmClient {
  // Pre-validate so test authoring catches invalid canned data.
  f2Decision.parse(canned);

  return {
    structured: async <T>(
      request: LlmRequest<T>,
    ): Promise<LlmResponse<T>> => {
      // Re-parse against the request's schema (which should be f2Decision).
      const parsed = request.schema.parse(canned) as T;
      return {
        output: parsed,
        model: {
          provider: 'openai',
          model: 'gpt-4o-test-fake',
          requestId: request.requestId,
        },
      };
    },
  };
}

/**
 * Create a fake {@link LlmClient} that throws a {@link LlmError}.
 */
function fakeErrorLlmClient(
  kind: 'timeout' | 'http_error' | 'provider_error' | 'schema_validation_failed',
): LlmClient {
  return {
    structured: async <T>(request: LlmRequest<T>): Promise<LlmResponse<T>> => {
      throw new LlmError(kind, 'openai', request.requestId, {
        httpStatus: kind === 'http_error' ? 500 : undefined,
      });
    },
  };
}

/**
 * Create a fake {@link LlmClient} that returns raw JSON that will NOT parse
 * against the f2Decision schema — simulates a model producing malformed output.
 */
function fakeMalformedLlmClient(malformed: unknown): LlmClient {
  return {
    structured: async <T>(
      request: LlmRequest<T>,
    ): Promise<LlmResponse<T>> => {
      // Return the malformed payload directly — the LlmClient's internal
      // schema validation will fail (in the real factory code), but since
      // we're mocking the client, we need to simulate the failure pattern.
      // We parse the request schema with the malformed data — if it fails,
      // we throw schema_validation_failed; if it passes (unlikely for
      // intentional malformation), the second pass in decideMerge will catch.
      try {
        const parsed = request.schema.parse(malformed) as T;
        return {
          output: parsed,
          model: {
            provider: 'openai',
            model: 'gpt-4o-test-fake',
            requestId: request.requestId,
          },
        };
      } catch {
        throw new LlmError(
          'schema_validation_failed',
          'openai',
          request.requestId,
        );
      }
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function deps(llm: LlmClient): MergeDeciderDeps {
  return { llm };
}

// ── CLI acceptance step 1: valid decision → accepted and parsed ────────────

describe('decideMerge — valid decisions (CLI acceptance step 1)', () => {
  it('accepts a confirms decision and returns the parsed F2Decision', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedConfirm())),
      newConcept(),
      [candidate(VALID_UUID)],
      'test-req-1',
    );

    expect(decision.relationship).toBe('confirms');
    expect(decision.targetConceptId).toBe(VALID_UUID);
    expect(decision.mergedTitle).toBeTruthy();
    expect(decision.mergedBody).toBeTruthy();
    expect(decision.resultStatus).toBe('active');
  });

  it('accepts an extends decision', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedExtend())),
      newConcept(),
      [candidate(VALID_UUID)],
      'test-req-2',
    );

    expect(decision.relationship).toBe('extends');
    expect(decision.targetConceptId).toBe(VALID_UUID);
    expect(decision.mergedTitle).toContain('connection pooling');
    expect(decision.resultStatus).toBe('active');
  });

  it('accepts an unrelated decision with null targetConceptId', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedUnrelated())),
      newConcept({ title: 'New CI pipeline' }),
      [], // no candidates
      'test-req-3',
    );

    expect(decision.relationship).toBe('unrelated');
    expect(decision.targetConceptId).toBeNull();
    expect(decision.mergedTitle).toContain('CI pipeline');
    expect(decision.resultStatus).toBe('active');
  });

  it('works with multiple candidates', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedConfirm())),
      newConcept(),
      [
        candidate(VALID_UUID),
        candidate(VALID_UUID_2, { title: 'Unrelated: use Redis', path: 'decisions/use-redis' }),
        candidate(VALID_UUID_3, { title: 'Another unrelated', path: 'decisions/something-else' }),
      ],
      'test-req-4',
    );

    expect(decision.relationship).toBe('confirms');
  });

  it('works with zero candidates (empty array)', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedUnrelated())),
      newConcept({ title: 'First concept ever' }),
      [],
      'test-req-5',
    );

    expect(decision.relationship).toBe('unrelated');
    expect(decision.targetConceptId).toBeNull();
  });
});

// ── CLI acceptance step 1 (cont.): malformed JSON → rejected ────────────────

describe('decideMerge — malformed JSON rejected (CLI acceptance step 1)', () => {
  it('rejects empty object', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({})),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-1',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects JSON with wrong relationship value', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'duplicate',
          targetConceptId: VALID_UUID,
          mergedTitle: 'Title',
          mergedBody: 'Body',
          resultStatus: 'active',
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-2',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects JSON with missing mergedBody', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'confirms',
          targetConceptId: VALID_UUID,
          mergedTitle: 'Title',
          resultStatus: 'active',
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-3',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects JSON with extra fields (model hallucination)', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'confirms',
          targetConceptId: VALID_UUID,
          mergedTitle: 'Title',
          mergedBody: 'Body',
          resultStatus: 'active',
          uuid: VALID_UUID, // server-owned field — must be rejected
          confidence: 'high', // server-owned field — must be rejected
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-4',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects null input', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient(null)),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-5',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects string (not JSON object)', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient('not an object')),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-6',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects array (not JSON object)', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient([])),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-7',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects unrelated with non-null targetConceptId', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'unrelated',
          targetConceptId: VALID_UUID, // must be null
          mergedTitle: 'Title',
          mergedBody: 'Body',
          resultStatus: 'active',
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-8',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects empty mergedTitle', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'confirms',
          targetConceptId: VALID_UUID,
          mergedTitle: '',
          mergedBody: 'Body',
          resultStatus: 'active',
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-9',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects empty mergedBody', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'confirms',
          targetConceptId: VALID_UUID,
          mergedTitle: 'Title',
          mergedBody: '',
          resultStatus: 'active',
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-mal-10',
      ),
    ).rejects.toThrow(LlmError);
  });
});

// ── CLI acceptance step 2: contradicts → disputed ─────────────────────────

describe('decideMerge — contradicts → disputed (CLI acceptance step 2)', () => {
  it('accepts contradicts with resultStatus=disputed', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedContradict())),
      newConcept({ title: 'Reconsider Postgres' }),
      [candidate(VALID_UUID)],
      'test-contra-1',
    );

    expect(decision.relationship).toBe('contradicts');
    expect(decision.targetConceptId).toBe(VALID_UUID);
    // The red line: resultStatus must be 'disputed', encoded as a literal in
    // the contradicts branch of f2Decision.
    expect(decision.resultStatus).toBe('disputed');
  });

  it('rejects contradicts with resultStatus=active (red line: only disputed allowed)', async () => {
    // Try to feed contradicts with active status through the schema.
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'contradicts',
          targetConceptId: VALID_UUID,
          mergedTitle: 'Conflict: Postgres vs MongoDB',
          mergedBody: '## Conflict\n\nWe have conflicting evidence.',
          resultStatus: 'active', // WRONG — must be 'disputed'
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-contra-2',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects contradicts with resultStatus=superseded', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'contradicts',
          targetConceptId: VALID_UUID,
          mergedTitle: 'Title',
          mergedBody: 'Body',
          resultStatus: 'superseded', // WRONG — must be 'disputed'
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-contra-3',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects contradicts with resultStatus=needs-review', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          relationship: 'contradicts',
          targetConceptId: VALID_UUID,
          mergedTitle: 'Title',
          mergedBody: 'Body',
          resultStatus: 'needs-review', // WRONG — must be 'disputed'
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-contra-4',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('TypeScript narrows resultStatus to "disputed" for contradicts', () => {
    // Static assertion: the type system enforces the red line.
    const d: F2Decision = cannedContradict();
    if (d.relationship === 'contradicts') {
      // TypeScript narrows: resultStatus is the literal 'disputed'
      const status: 'disputed' = d.resultStatus;
      expect(status).toBe('disputed');
    }
  });
});

// ── Provider error propagation ──────────────────────────────────────────────

describe('decideMerge — provider error propagation', () => {
  it('propagates timeout errors', async () => {
    await expect(
      decideMerge(
        deps(fakeErrorLlmClient('timeout')),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-err-1',
      ),
    ).rejects.toThrow(LlmError);
    try {
      await decideMerge(
        deps(fakeErrorLlmClient('timeout')),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-err-1b',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe('timeout');
    }
  });

  it('propagates HTTP errors', async () => {
    try {
      await decideMerge(
        deps(fakeErrorLlmClient('http_error')),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-err-2',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe('http_error');
      expect((err as LlmError).httpStatus).toBe(500);
    }
  });

  it('propagates provider errors', async () => {
    try {
      await decideMerge(
        deps(fakeErrorLlmClient('provider_error')),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-err-3',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe('provider_error');
    }
  });

  it('propagates schema_validation_failed errors', async () => {
    try {
      await decideMerge(
        deps(fakeErrorLlmClient('schema_validation_failed')),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-err-4',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe('schema_validation_failed');
    }
  });
});

// ── Boundary cases ──────────────────────────────────────────────────────────

describe('decideMerge — boundary cases', () => {
  it('handles candidate with minimal fields', async () => {
    const minimalCandidate: CandidateConceptSummary = {
      uuid: VALID_UUID,
      type: 'concept',
      status: 'active',
      title: 'Minimal',
      body: 'Minimal body',
      path: 'concepts/minimal',
      tags: [],
      evidenceSummary: [],
    };

    const decision = await decideMerge(
      deps(fakeLlmClient(cannedConfirm())),
      newConcept(),
      [minimalCandidate],
      'test-boundary-1',
    );

    expect(decision.relationship).toBe('confirms');
  });

  it('handles candidate with very long body', async () => {
    const longCandidate = candidate(VALID_UUID, {
      body: 'A'.repeat(10_000),
    });

    const decision = await decideMerge(
      deps(fakeLlmClient(cannedConfirm())),
      newConcept(),
      [longCandidate],
      'test-boundary-2',
    );

    expect(decision.relationship).toBe('confirms');
  });

  it('handles candidate with many evidence items', async () => {
    const manyEvidence = candidate(VALID_UUID, {
      evidenceSummary: Array.from({ length: 20 }, (_, i) =>
        `commit: https://github.com/org/repo/commit/abc${i}`
      ),
    });

    const decision = await decideMerge(
      deps(fakeLlmClient(cannedConfirm())),
      newConcept(),
      [manyEvidence],
      'test-boundary-3',
    );

    expect(decision.relationship).toBe('confirms');
  });

  it('handles candidate with special characters in body', async () => {
    const specialCandidate = candidate(VALID_UUID, {
      body: '## Decision\n\nWe chose `<script>alert("xss")</script>` for templating.\n\n```typescript\nconst x = `<div>${userInput}</div>`;\n```',
    });

    const decision = await decideMerge(
      deps(fakeLlmClient(cannedConfirm())),
      newConcept(),
      [specialCandidate],
      'test-boundary-4',
    );

    expect(decision.relationship).toBe('confirms');
  });

  it('handles new knowledge with very long body', async () => {
    const longNewConcept = newConcept({
      body: 'B'.repeat(10_000),
    });

    const decision = await decideMerge(
      deps(fakeLlmClient(cannedUnrelated())),
      longNewConcept,
      [],
      'test-boundary-5',
    );

    expect(decision.relationship).toBe('unrelated');
  });

  it('passes the requestId through to the LlmClient', async () => {
    let capturedRequestId: string | undefined;

    const capturingLlm: LlmClient = {
      structured: async <T>(
        request: LlmRequest<T>,
      ): Promise<LlmResponse<T>> => {
        capturedRequestId = request.requestId;
        const parsed = request.schema.parse(cannedConfirm()) as T;
        return {
          output: parsed,
          model: {
            provider: 'openai',
            model: 'gpt-4o',
            requestId: request.requestId,
          },
        };
      },
    };

    await decideMerge(
      deps(capturingLlm),
      newConcept(),
      [candidate(VALID_UUID)],
      'my-custom-request-id-123',
    );

    expect(capturedRequestId).toBe('my-custom-request-id-123');
  });

  it('passes the f2Decision schema to the LlmClient for structured output', async () => {
    let capturedSchema: unknown;

    const schemaCapturingLlm: LlmClient = {
      structured: async <T>(
        request: LlmRequest<T>,
      ): Promise<LlmResponse<T>> => {
        capturedSchema = request.schema;
        // Parse and return canned confirm (must validate against the real schema).
        const parsed = request.schema.parse(cannedConfirm()) as T;
        return {
          output: parsed,
          model: {
            provider: 'openai',
            model: 'gpt-4o',
            requestId: request.requestId,
          },
        };
      },
    };

    await decideMerge(
      deps(schemaCapturingLlm),
      newConcept(),
      [candidate(VALID_UUID)],
      'test-schema-capture',
    );

    // Verify the schema is the f2Decision discriminated union.
    expect(capturedSchema).toBe(f2Decision);
  });
});

// ── All four relationship branches ──────────────────────────────────────────

describe('decideMerge — all four relationship branches', () => {
  it('confirms: targetConceptId is the existing UUID, content merged', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedConfirm())),
      newConcept(),
      [candidate(VALID_UUID)],
      'test-branch-confirms',
    );

    expect(decision.relationship).toBe('confirms');
    expect(decision.targetConceptId).toBe(VALID_UUID);
    expect(decision.mergedTitle).toBeTruthy();
    expect(decision.mergedBody).toBeTruthy();
  });

  it('extends: targetConceptId is the existing UUID, content expanded', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedExtend())),
      newConcept({ title: 'Use Postgres — expanded' }),
      [candidate(VALID_UUID)],
      'test-branch-extends',
    );

    expect(decision.relationship).toBe('extends');
    expect(decision.targetConceptId).toBe(VALID_UUID);
    expect(decision.mergedTitle).toContain('connection pooling');
  });

  it('contradicts: targetConceptId exists, resultStatus is disputed', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedContradict())),
      newConcept(),
      [candidate(VALID_UUID)],
      'test-branch-contradicts',
    );

    expect(decision.relationship).toBe('contradicts');
    expect(decision.targetConceptId).toBe(VALID_UUID);
    expect(decision.resultStatus).toBe('disputed');
  });

  it('unrelated: targetConceptId is null, creates new concept', async () => {
    const decision = await decideMerge(
      deps(fakeLlmClient(cannedUnrelated())),
      newConcept({ title: 'CI pipeline setup' }),
      [candidate(VALID_UUID, { title: 'Completely different topic' })],
      'test-branch-unrelated',
    );

    expect(decision.relationship).toBe('unrelated');
    expect(decision.targetConceptId).toBeNull();
    expect(decision.mergedTitle).toBeTruthy();
  });
});

// ── Security: model-invented fields ─────────────────────────────────────────

describe('decideMerge — model-invented fields rejected (strictObject)', () => {
  it('rejects model adding a "uuid" field', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          ...cannedConfirm(),
          uuid: '00000000-0000-0000-0000-000000000000',
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-sec-1',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects model adding "evidence" field', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          ...cannedConfirm(),
          evidence: [{ kind: 'pr', ref: 'https://example.com', at: '2025-01-01T00:00:00.000Z' }],
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-sec-2',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects model adding "contributors" field', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          ...cannedConfirm(),
          contributors: ['alice', 'bob'],
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-sec-3',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects model adding "schemaVersion" field', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          ...cannedConfirm(),
          schemaVersion: 1,
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-sec-4',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects model adding "confidence" field (server-owned)', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          ...cannedConfirm(),
          confidence: 'high',
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-sec-5',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects model adding "path" field (server-owned)', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          ...cannedConfirm(),
          path: 'decisions/some-path',
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-sec-6',
      ),
    ).rejects.toThrow(LlmError);
  });

  it('rejects model adding "tags" field (server-owned)', async () => {
    await expect(
      decideMerge(
        deps(fakeMalformedLlmClient({
          ...cannedConfirm(),
          tags: ['database'],
        })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-sec-7',
      ),
    ).rejects.toThrow(LlmError);
  });
});

// ── Error message redaction (no raw payloads leaked) ────────────────────────

describe('decideMerge — error messages are redacted', () => {
  it('LlmError does not carry the raw model payload in its message', () => {
    const err = new LlmError('schema_validation_failed', 'openai', 'req-1');
    // The message should describe the failure kind, not include raw JSON.
    expect(err.message).toContain('schema_validation_failed');
    expect(err.message).toContain('openai');
    // It must NOT contain placeholder raw content (the error is constructed
    // with only kind, provider, requestId — no raw body).
    expect(err.name).toBe('LlmError');
    // No cause attached (red line §5.3).
    expect(err.cause).toBeUndefined();
  });

  it('schema_validation_failed from malformed input does not leak the malformed payload in the error message', async () => {
    try {
      await decideMerge(
        deps(fakeMalformedLlmClient({ garbage: 'should-fail' })),
        newConcept(),
        [candidate(VALID_UUID)],
        'test-redact-1',
      );
      // Should not reach here.
      expect.unreachable('Expected LlmError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      const llmErr = err as LlmError;
      expect(llmErr.kind).toBe('schema_validation_failed');
      // Message is redacted — no raw payload.
      expect(llmErr.message).not.toContain('garbage');
      expect(llmErr.message).not.toContain('should-fail');
    }
  });
});
