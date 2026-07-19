/**
 * F1 structured output contract tests.
 *
 * Validates the F1 output schema (output.ts) and prompt builder (prompt.ts)
 * against success paths, failure paths, and fabrication-rejection counterexamples.
 *
 * No database required — pure Zod validation tests.
 * No mocks — the schema IS the contract under test.
 */
import { describe, expect, it } from 'vitest';
import { f1Output, type F1Output } from './output.js';
import { buildF1Prompt, type F1PromptContext } from './prompt.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function validExtract(overrides?: Partial<Record<string, unknown>>): F1Output {
  return {
    action: 'extract',
    type: 'decision',
    title: 'Use Postgres for the main datastore',
    body: '## Decision\n\nWe chose Postgres over MongoDB for the primary datastore.\n\n### Rationale\n\n- Strong ACID guarantees\n- Mature ecosystem\n- JSONB for flexible schemas',
    path: 'decisions/use-postgres',
    tags: ['database', 'postgres', 'architecture'],
    confidence: 'high',
    ...overrides,
  } as F1Output;
}

function validSkip(overrides?: Partial<Record<string, unknown>>): F1Output {
  return {
    action: 'skip',
    reason: 'Event is a Dependabot version bump with no team knowledge',
    ...overrides,
  } as F1Output;
}

const promptContext: F1PromptContext = {
  channel: 'github',
  kind: 'github_pr',
  externalId: 'org/repo#42',
  payload: {
    title: 'Use Postgres for the main datastore',
    body: 'We decided to use Postgres...',
  },
};

// ── Concept type coverage: all six types must pass validation (CLI acceptance) ─

describe('f1Output — concept type coverage (all six types pass)', () => {
  const types = [
    'service',
    'concept',
    'decision',
    'gotcha',
    'convention',
    'runbook',
  ] as const;

  for (const type of types) {
    it(`accepts type "${type}"`, () => {
      const result = f1Output.safeParse({
        action: 'extract',
        type,
        title: `Test ${type}`,
        body: `Body for ${type}`,
        path: `test/${type}-example`,
        tags: [type],
        confidence: 'medium',
      });
      expect(result.success, `type "${type}" should pass but got: ${JSON.stringify(result)}`).toBe(true);
    });
  }
});

// ── Success paths ────────────────────────────────────────────────────────────

describe('f1Output — success paths', () => {
  it('accepts a valid extract', () => {
    const result = f1Output.safeParse(validExtract());
    expect(result.success).toBe(true);
  });

  it('accepts a valid skip', () => {
    const result = f1Output.safeParse(validSkip());
    expect(result.success).toBe(true);
  });

  it('accepts extract with empty tags array', () => {
    const result = f1Output.safeParse(validExtract({ tags: [] }));
    expect(result.success).toBe(true);
  });

  it('accepts extract with low confidence', () => {
    const result = f1Output.safeParse(validExtract({ confidence: 'low' }));
    expect(result.success).toBe(true);
  });

  it('accepts extract with complex markdown body', () => {
    const result = f1Output.safeParse(
      validExtract({
        body:
          '## Overview\n\nThis is a **bold** decision.\n\n```typescript\nconst x = 1;\n```\n\nSee [link](https://example.com) for details.',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts extract with deep concept path', () => {
    const result = f1Output.safeParse(
      validExtract({ path: 'services/auth/api-gateway' }),
    );
    expect(result.success).toBe(true);
  });
});

// ── Failure paths: unknown fields rejected (strict object) ──────────────────

describe('f1Output — unknown field rejection', () => {
  it('rejects extract with extra field "uuid"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      uuid: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "createdAt"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      createdAt: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "evidence"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      evidence: [{ kind: 'pr', ref: 'https://example.com', at: '2026-07-17T00:00:00.000Z' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "contributors"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      contributors: ['pri_01H'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "status"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      status: 'active',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "schemaVersion"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "supersedes"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      supersedes: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "aliases"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      aliases: ['old/path'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "firstSeen"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      firstSeen: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "lastConfirmed"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      lastConfirmed: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with extra field "updatedAt"', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      updatedAt: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

// ── Failure paths: missing required fields ───────────────────────────────────

describe('f1Output — missing required fields', () => {
  function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
    const { [key]: _omitted, ...rest } = obj;
    void _omitted;
    return rest;
  }

  it('rejects extract without "action"', () => {
    const result = f1Output.safeParse(omit(validExtract() as Record<string, unknown>, 'action'));
    expect(result.success).toBe(false);
  });

  it('rejects extract without "type"', () => {
    const result = f1Output.safeParse(omit(validExtract() as Record<string, unknown>, 'type'));
    expect(result.success).toBe(false);
  });

  it('rejects extract without "title"', () => {
    const result = f1Output.safeParse(omit(validExtract() as Record<string, unknown>, 'title'));
    expect(result.success).toBe(false);
  });

  it('rejects extract without "body"', () => {
    const result = f1Output.safeParse(omit(validExtract() as Record<string, unknown>, 'body'));
    expect(result.success).toBe(false);
  });

  it('rejects extract without "path"', () => {
    const result = f1Output.safeParse(omit(validExtract() as Record<string, unknown>, 'path'));
    expect(result.success).toBe(false);
  });

  it('rejects extract without "tags"', () => {
    const result = f1Output.safeParse(omit(validExtract() as Record<string, unknown>, 'tags'));
    expect(result.success).toBe(false);
  });

  it('rejects extract without "confidence"', () => {
    const result = f1Output.safeParse(omit(validExtract() as Record<string, unknown>, 'confidence'));
    expect(result.success).toBe(false);
  });

  it('rejects skip without "reason"', () => {
    const result = f1Output.safeParse(omit(validSkip() as Record<string, unknown>, 'reason'));
    expect(result.success).toBe(false);
  });
});

// ── Failure paths: invalid values ────────────────────────────────────────────

describe('f1Output — invalid values', () => {
  it('rejects extract with unknown concept type', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      type: 'unknown_type',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with unknown confidence level', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      confidence: 'certain',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with invalid path format', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      path: '../etc/passwd',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with uppercase path', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      path: 'Decisions/Use-Postgres',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with empty title', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      title: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract with empty body', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      body: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts extract with empty tags containing empty string (tags are plain strings per contract)', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      tags: [''],
    });
    expect(result.success).toBe(true);
  });

  it('rejects extract with non-array tags', () => {
    const result = f1Output.safeParse({
      ...validExtract(),
      tags: 'database',
    });
    expect(result.success).toBe(false);
  });
});

// ── Fabrication counterexamples: model-invented server-owned facts ───────────

describe('f1Output — fabrication rejection (model cannot invent server facts)', () => {
  it('rejects model-invented UUID', () => {
    const result = f1Output.safeParse({
      action: 'extract',
      type: 'decision',
      title: 'Use Postgres',
      body: 'We chose Postgres.',
      path: 'decisions/use-postgres',
      tags: ['database'],
      confidence: 'high',
      uuid: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented timestamps', () => {
    const result = f1Output.safeParse({
      action: 'extract',
      type: 'decision',
      title: 'Use Postgres',
      body: 'We chose Postgres.',
      path: 'decisions/use-postgres',
      tags: ['database'],
      confidence: 'high',
      createdAt: '2026-07-17T00:00:00.000Z',
      firstSeen: '2026-07-17T00:00:00.000Z',
      lastConfirmed: '2026-07-17T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented evidence', () => {
    const result = f1Output.safeParse({
      action: 'extract',
      type: 'decision',
      title: 'Use Postgres',
      body: 'We chose Postgres.',
      path: 'decisions/use-postgres',
      tags: ['database'],
      confidence: 'high',
      evidence: [
        {
          kind: 'pr',
          ref: 'https://github.com/org/repo/pull/42',
          at: '2026-07-17T00:00:00.000Z',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented actor', () => {
    const result = f1Output.safeParse({
      action: 'extract',
      type: 'decision',
      title: 'Use Postgres',
      body: 'We chose Postgres.',
      path: 'decisions/use-postgres',
      tags: ['database'],
      confidence: 'high',
      contributors: ['pri_01H'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented provenance', () => {
    const result = f1Output.safeParse({
      action: 'extract',
      type: 'decision',
      title: 'Use Postgres',
      body: 'We chose Postgres.',
      path: 'decisions/use-postgres',
      tags: ['database'],
      confidence: 'high',
      actorProvenance: 'webhook_verified',
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented schemaVersion', () => {
    const result = f1Output.safeParse({
      action: 'extract',
      type: 'decision',
      title: 'Use Postgres',
      body: 'We chose Postgres.',
      path: 'decisions/use-postgres',
      tags: ['database'],
      confidence: 'high',
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects model-invented supersedes', () => {
    const result = f1Output.safeParse({
      action: 'extract',
      type: 'decision',
      title: 'Use Postgres',
      body: 'We chose Postgres.',
      path: 'decisions/use-postgres',
      tags: ['database'],
      confidence: 'high',
      supersedes: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    });
    expect(result.success).toBe(false);
  });
});

// ── Boundary/edge cases ──────────────────────────────────────────────────────

describe('f1Output — boundary cases', () => {
  it('rejects action that is neither extract nor skip', () => {
    const result = f1Output.safeParse({
      action: 'update',
      type: 'decision',
      title: 'Use Postgres',
      body: 'We chose Postgres.',
      path: 'decisions/use-postgres',
      tags: ['database'],
      confidence: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty object', () => {
    const result = f1Output.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = f1Output.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('rejects array', () => {
    const result = f1Output.safeParse([]);
    expect(result.success).toBe(false);
  });

  it('rejects extract with path exceeding 200 chars', () => {
    const longPath = 'a/'.repeat(101) + 'b';
    expect(longPath.length).toBeGreaterThan(200);
    const result = f1Output.safeParse({
      action: 'extract',
      type: 'concept',
      title: 'Long path',
      body: 'Body',
      path: longPath,
      tags: [],
      confidence: 'low',
    });
    expect(result.success).toBe(false);
  });
});

// ── Prompt builder tests ─────────────────────────────────────────────────────

describe('buildF1Prompt', () => {
  it('returns system and user messages', () => {
    const { system, user } = buildF1Prompt(promptContext);
    expect(system).toBeTruthy();
    expect(user).toBeTruthy();
  });

  it('system message includes all six concept types', () => {
    const { system } = buildF1Prompt(promptContext);
    for (const type of ['service', 'concept', 'decision', 'gotcha', 'convention', 'runbook']) {
      expect(system).toContain(type);
    }
  });

  it('system message explicitly forbids server-owned fields', () => {
    const { system } = buildF1Prompt(promptContext);
    expect(system).toContain('uuid');
    expect(system).toContain('evidence');
    expect(system).toContain('contributors');
    expect(system).toContain('schemaVersion');
    expect(system).toContain('firstSeen');
    expect(system).toContain('lastConfirmed');
    expect(system).toContain('createdAt');
    expect(system).toContain('updatedAt');
    expect(system).toContain('aliases');
    expect(system).toContain('supersedes');
  });

  it('system message includes extract and skip output formats', () => {
    const { system } = buildF1Prompt(promptContext);
    expect(system).toContain('"action": "extract"');
    expect(system).toContain('"action": "skip"');
  });

  it('user message includes event context', () => {
    const { user } = buildF1Prompt(promptContext);
    expect(user).toContain('github');
    expect(user).toContain('github_pr');
    expect(user).toContain('org/repo#42');
    expect(user).toContain('Use Postgres');
  });

  it('user message includes the full payload as JSON', () => {
    const { user } = buildF1Prompt(promptContext);
    expect(user).toContain(JSON.stringify(promptContext.payload, null, 2));
  });
});

// ── Type narrowing: discriminated union types ────────────────────────────────

describe('f1Output — type narrowing', () => {
  it('narrows to extract on action="extract"', () => {
    const result = f1Output.parse(validExtract());
    if (result.action === 'extract') {
      // TypeScript should narrow to F1ExtractOutput here
      expect(result.type).toBe('decision');
      expect(result.title).toBeTruthy();
      expect(result.body).toBeTruthy();
      expect(result.path).toBeTruthy();
      expect(result.tags).toBeInstanceOf(Array);
      expect(result.confidence).toBeTruthy();
    } else {
      throw new Error('Expected action to be extract');
    }
  });

  it('narrows to skip on action="skip"', () => {
    const result = f1Output.parse(validSkip());
    if (result.action === 'skip') {
      expect(result.reason).toBeTruthy();
    } else {
      throw new Error('Expected action to be skip');
    }
  });
});
