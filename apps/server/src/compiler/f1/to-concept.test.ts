/**
 * F1 concept page aggregate mapper tests.
 *
 * Validates toConcept() against:
 * - Success paths: all five evidence types (CLI repo_file, GitHub commit/PR/
 *   issue/comment) plus MCP write
 * - Failure paths: missing URL, missing immutable repo_file fields, unknown
 *   source kind, invalid commitSha format
 * - Contributor rules: trusted (webhook_verified, credential_bound) vs
 *   untrusted (client_claimed, unknown)
 * - Server-owned fact generation: UUID uniqueness, timestamps, active status
 * - Frozen contract validation: every mapped aggregate passes the
 *   @teamem/schema concept DTO
 *
 * Pure unit tests — no database required.
 */
import { describe, expect, it } from 'vitest';
import { concept } from '@teamem/schema';
import { toConcept, type ToConceptInput } from './to-concept.js';
import type { F1ExtractOutput } from './output.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function validF1Output(overrides?: Partial<F1ExtractOutput>): F1ExtractOutput {
  return {
    action: 'extract' as const,
    type: 'decision',
    title: 'Use Postgres for the main datastore',
    body: '## Decision\n\nWe chose Postgres over MongoDB.',
    path: 'decisions/use-postgres',
    tags: ['database', 'postgres', 'architecture'],
    confidence: 'high',
    ...overrides,
  };
}

function baseInput(overrides?: Partial<ToConceptInput>): ToConceptInput {
  return {
    f1Output: validF1Output(),
    channel: 'github',
    kind: 'github_pr',
    externalId: 'teamem-ai/teamem#42',
    url: 'https://github.com/teamem-ai/teamem/pull/42',
    occurredAt: new Date('2025-01-15T10:30:00.000Z'),
    eventId: 'evt_a1b2c3d4e5f6',
    actorProvenance: 'webhook_verified',
    actorPrincipalId: 'pri_alice',
    ingestedByPrincipalId: null,
    payload: {},
    teamId: 'team_test',
    projectId: 'prj_test',
    ...overrides,
  };
}

// ── CLI acceptance helper: validate aggregate against frozen concept DTO ────

function validateAgainstConceptDto(input: ToConceptInput): void {
  const result = toConcept(input);
  expect(result).not.toBeNull();

  // Build the full concept shape as it would be returned by the API.
  // The write repository adds uuid, createdAt, updatedAt, aliases,
  // supersedes, schemaVersion, contributors (filtered), and evidence.
  const ci = result!.conceptInput;

  const conceptDto = {
    uuid: result!.conceptUuid,
    path: ci.path,
    type: ci.type,
    status: ci.status,
    confidence: ci.confidence,
    title: ci.title,
    tags: ci.tags ?? [],
    lastConfirmed: ci.lastConfirmed.toISOString(),
    schemaVersion: ci.schemaVersion,
    firstSeen: ci.firstSeen.toISOString(),
    contributors: (ci.contributors ?? [])
      .filter((c) => ['webhook_verified', 'credential_bound'].includes(c.provenance))
      .map((c) => c.principalId),
    evidence: ci.evidence.map((ev) => ({
      ...ev,
      at: ev.at instanceof Date ? ev.at.toISOString() : ev.at,
    })),
    supersedes: null,
    aliases: [],
    body: ci.body,
    createdAt: new Date().toISOString(),
  };

  const parseResult = concept.safeParse(conceptDto);
  expect(
    parseResult.success,
    `Concept DTO validation failed: ${JSON.stringify(parseResult.error?.issues ?? 'unknown')}`,
  ).toBe(true);
}

// ── Success paths: CLI repo_file evidence ────────────────────────────────────

describe('toConcept — CLI repo_file evidence', () => {
  it('maps cli_init to a concept with repo_file evidence', () => {
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      externalId: 'teamem-ai/teamem:src/index.ts',
      payload: {
        repo: 'teamem-ai/teamem',
        commitSha: 'abc1234def5678',
        path: 'src/index.ts',
        content: 'console.log("hello");',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();

    const ci = result!.conceptInput;
    expect(ci.evidence).toHaveLength(1);
    expect(ci.evidence[0]!.kind).toBe('repo_file');
    expect(ci.evidence[0]!.repo).toBe('teamem-ai/teamem');
    expect(ci.evidence[0]!.commitSha).toBe('abc1234def5678');
    expect(ci.evidence[0]!.path).toBe('src/index.ts');
    expect(ci.evidence[0]!.at).toEqual(new Date('2025-01-15T10:30:00.000Z'));
  });

  it('validates against frozen concept DTO for cli_init', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'cli',
        kind: 'cli_init',
        url: null,
        externalId: 'teamem-ai/teamem:src/index.ts',
        payload: {
          repo: 'teamem-ai/teamem',
          commitSha: 'abc1234def5678',
          path: 'src/index.ts',
          content: 'console.log("hello");',
          schemaVersion: 1,
        },
      }),
    );
  });

  it('accepts minimum valid commitSha (7 hex chars)', () => {
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      payload: {
        repo: 'teamem-ai/teamem',
        commitSha: 'abc1234',
        path: 'src/index.ts',
        content: 'x',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    expect(result!.conceptInput.evidence[0]!.commitSha).toBe('abc1234');
  });

  it('accepts maximum valid commitSha (40 hex chars)', () => {
    const sha40 = 'a'.repeat(40);
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      payload: {
        repo: 'teamem-ai/teamem',
        commitSha: sha40,
        path: 'src/index.ts',
        content: 'x',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    expect(result!.conceptInput.evidence[0]!.commitSha).toBe(sha40);
  });
});

// ── Success paths: GitHub commit evidence ────────────────────────────────────

describe('toConcept — GitHub commit evidence', () => {
  it('maps github_commit to a concept with commit evidence', () => {
    const input = baseInput({
      channel: 'github',
      kind: 'github_commit',
      url: 'https://github.com/teamem-ai/teamem/commit/abc1234def5678',
      externalId: 'teamem-ai/teamem@abc1234',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();

    const ci = result!.conceptInput;
    expect(ci.evidence).toHaveLength(1);
    expect(ci.evidence[0]!.kind).toBe('commit');
    expect(ci.evidence[0]!.ref).toBe('https://github.com/teamem-ai/teamem/commit/abc1234def5678');
    expect(ci.evidence[0]!.at).toEqual(new Date('2025-01-15T10:30:00.000Z'));
  });

  it('validates against frozen concept DTO for github_commit', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'github',
        kind: 'github_commit',
        url: 'https://github.com/teamem-ai/teamem/commit/abc1234def5678',
        externalId: 'teamem-ai/teamem@abc1234',
      }),
    );
  });
});

// ── Success paths: GitHub PR evidence ────────────────────────────────────────

describe('toConcept — GitHub PR evidence', () => {
  it('maps github_pr to a concept with pr evidence', () => {
    const input = baseInput({
      channel: 'github',
      kind: 'github_pr',
      url: 'https://github.com/teamem-ai/teamem/pull/42',
      externalId: 'teamem-ai/teamem#42',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();

    const ci = result!.conceptInput;
    expect(ci.evidence).toHaveLength(1);
    expect(ci.evidence[0]!.kind).toBe('pr');
    expect(ci.evidence[0]!.ref).toBe('https://github.com/teamem-ai/teamem/pull/42');
  });

  it('validates against frozen concept DTO for github_pr', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'github',
        kind: 'github_pr',
        url: 'https://github.com/teamem-ai/teamem/pull/42',
        externalId: 'teamem-ai/teamem#42',
      }),
    );
  });
});

// ── Success paths: GitHub issue evidence ─────────────────────────────────────

describe('toConcept — GitHub issue evidence', () => {
  it('maps github_issue to a concept with issue evidence', () => {
    const input = baseInput({
      channel: 'github',
      kind: 'github_issue',
      url: 'https://github.com/teamem-ai/teamem/issues/99',
      externalId: 'teamem-ai/teamem#99',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();

    const ci = result!.conceptInput;
    expect(ci.evidence).toHaveLength(1);
    expect(ci.evidence[0]!.kind).toBe('issue');
    expect(ci.evidence[0]!.ref).toBe('https://github.com/teamem-ai/teamem/issues/99');
  });

  it('validates against frozen concept DTO for github_issue', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'github',
        kind: 'github_issue',
        url: 'https://github.com/teamem-ai/teamem/issues/99',
        externalId: 'teamem-ai/teamem#99',
      }),
    );
  });
});

// ── Success paths: GitHub PR comment evidence ────────────────────────────────

describe('toConcept — GitHub PR comment evidence', () => {
  it('maps github_pr_comment to a concept with pr_comment evidence', () => {
    const input = baseInput({
      channel: 'github',
      kind: 'github_pr_comment',
      url: 'https://github.com/teamem-ai/teamem/pull/42#discussion_r123',
      externalId: 'teamem-ai/teamem#42',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();

    const ci = result!.conceptInput;
    expect(ci.evidence).toHaveLength(1);
    expect(ci.evidence[0]!.kind).toBe('pr_comment');
    expect(ci.evidence[0]!.ref).toBe('https://github.com/teamem-ai/teamem/pull/42#discussion_r123');
  });

  it('validates against frozen concept DTO for github_pr_comment', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'github',
        kind: 'github_pr_comment',
        url: 'https://github.com/teamem-ai/teamem/pull/42#discussion_r123',
        externalId: 'teamem-ai/teamem#42',
      }),
    );
  });
});

// ── Success paths: MCP write evidence ────────────────────────────────────────

describe('toConcept — MCP write evidence', () => {
  it('maps mcp_write to a concept with mcp_write evidence using eventId as ref', () => {
    const input = baseInput({
      channel: 'mcp',
      kind: 'mcp_write',
      url: null,
      externalId: 'mcp_tool_call',
      eventId: 'evt_mcp_12345',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();

    const ci = result!.conceptInput;
    expect(ci.evidence).toHaveLength(1);
    expect(ci.evidence[0]!.kind).toBe('mcp_write');
    expect(ci.evidence[0]!.ref).toBe('evt_mcp_12345');
  });

  it('validates against frozen concept DTO for mcp_write', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'mcp',
        kind: 'mcp_write',
        url: null,
        externalId: 'mcp_tool_call',
        eventId: 'evt_mcp_12345',
      }),
    );
  });
});

// ── Failure: missing evidence → null (no concept) ───────────────────────────

describe('toConcept — missing evidence returns null', () => {
  it('returns null for github_commit without URL', () => {
    const input = baseInput({
      channel: 'github',
      kind: 'github_commit',
      url: null,
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for github_pr without URL', () => {
    const input = baseInput({
      channel: 'github',
      kind: 'github_pr',
      url: null,
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for github_issue without URL', () => {
    const input = baseInput({
      channel: 'github',
      kind: 'github_issue',
      url: null,
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for github_pr_comment without URL', () => {
    const input = baseInput({
      channel: 'github',
      kind: 'github_pr_comment',
      url: null,
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for cli_init with missing repo', () => {
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      payload: {
        // repo missing
        commitSha: 'abc1234def5678',
        path: 'src/index.ts',
        content: 'x',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for cli_init with missing commitSha', () => {
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      payload: {
        repo: 'teamem-ai/teamem',
        // commitSha missing
        path: 'src/index.ts',
        content: 'x',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for cli_init with missing path', () => {
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      payload: {
        repo: 'teamem-ai/teamem',
        commitSha: 'abc1234def5678',
        // path missing
        content: 'x',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for cli_init with invalid commitSha format (too short)', () => {
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      payload: {
        repo: 'teamem-ai/teamem',
        commitSha: 'abc12', // only 5 chars, need ≥ 7
        path: 'src/index.ts',
        content: 'x',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for cli_init with invalid commitSha format (non-hex)', () => {
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      payload: {
        repo: 'teamem-ai/teamem',
        commitSha: 'xyz1234ghijk', // 'g' is not hex
        path: 'src/index.ts',
        content: 'x',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for cli_init with overly long commitSha (>40 chars)', () => {
    const input = baseInput({
      channel: 'cli',
      kind: 'cli_init',
      url: null,
      payload: {
        repo: 'teamem-ai/teamem',
        commitSha: 'a'.repeat(41), // 41 chars, need ≤ 40
        path: 'src/index.ts',
        content: 'x',
        schemaVersion: 1,
      },
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('returns null for unknown source kind', () => {
    const input = baseInput({
      channel: 'external',
      kind: 'external_event',
      url: 'https://example.com/event',
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });

  it('does not fabricate evidence for unknown kind (no fake commit/PR)', () => {
    const input = baseInput({
      kind: 'external_event' as never,
      url: 'https://example.com/event',
    });

    const result = toConcept(input);
    expect(result).toBeNull();
  });
});

// ── Contributor rules ───────────────────────────────────────────────────────

describe('toConcept — contributor rules', () => {
  it('includes webhook_verified actor principal as contributor candidate', () => {
    const input = baseInput({
      actorProvenance: 'webhook_verified',
      actorPrincipalId: 'pri_alice',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    const contributors = result!.conceptInput.contributors ?? [];
    expect(contributors).toHaveLength(1);
    expect(contributors[0]!.principalId).toBe('pri_alice');
    expect(contributors[0]!.provenance).toBe('webhook_verified');
  });

  it('includes credential_bound actor principal as contributor candidate', () => {
    const input = baseInput({
      actorProvenance: 'credential_bound',
      actorPrincipalId: 'pri_bob',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    const contributors = result!.conceptInput.contributors ?? [];
    expect(contributors).toHaveLength(1);
    expect(contributors[0]!.principalId).toBe('pri_bob');
    expect(contributors[0]!.provenance).toBe('credential_bound');
  });

  it('includes client_claimed actor as candidate (repository filters, not mapper)', () => {
    // The mapper offers all candidates; the repository is responsible for
    // dropping client_claimed/unknown. This test verifies the mapper does
    // NOT pre-filter — it preserves the provenance for the repository.
    const input = baseInput({
      actorProvenance: 'client_claimed',
      actorPrincipalId: 'pri_eve',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    const contributors = result!.conceptInput.contributors ?? [];
    expect(contributors).toHaveLength(1);
    expect(contributors[0]!.principalId).toBe('pri_eve');
    expect(contributors[0]!.provenance).toBe('client_claimed');
  });

  it('includes unknown actor as candidate (repository filters, not mapper)', () => {
    const input = baseInput({
      actorProvenance: 'unknown',
      actorPrincipalId: 'pri_unknown',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    const contributors = result!.conceptInput.contributors ?? [];
    expect(contributors).toHaveLength(1);
    expect(contributors[0]!.principalId).toBe('pri_unknown');
    expect(contributors[0]!.provenance).toBe('unknown');
  });

  it('includes ingestedByPrincipalId as credential_bound contributor', () => {
    const input = baseInput({
      actorProvenance: 'webhook_verified',
      actorPrincipalId: 'pri_alice',
      ingestedByPrincipalId: 'pri_ingester',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    const contributors = result!.conceptInput.contributors ?? [];
    // Both actor and ingester should be present
    expect(contributors).toHaveLength(2);
    const pids = contributors.map((c) => c.principalId).sort();
    expect(pids).toEqual(['pri_alice', 'pri_ingester']);
  });

  it('deduplicates when actorPrincipalId equals ingestedByPrincipalId', () => {
    const input = baseInput({
      actorProvenance: 'credential_bound',
      actorPrincipalId: 'pri_same',
      ingestedByPrincipalId: 'pri_same',
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    const contributors = result!.conceptInput.contributors ?? [];
    expect(contributors).toHaveLength(1);
    expect(contributors[0]!.principalId).toBe('pri_same');
    expect(contributors[0]!.provenance).toBe('credential_bound');
  });

  it('returns undefined contributors when none are available', () => {
    const input = baseInput({
      actorProvenance: 'unknown',
      actorPrincipalId: null,
      ingestedByPrincipalId: null,
    });

    const result = toConcept(input);
    expect(result).not.toBeNull();
    expect(result!.conceptInput.contributors).toBeUndefined();
  });
});

// ── Server-owned fact generation ─────────────────────────────────────────────

describe('toConcept — server-owned fact generation', () => {
  it('generates a unique UUID for each call', () => {
    const input = baseInput();
    const r1 = toConcept(input);
    const r2 = toConcept(input);

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.conceptUuid).not.toBe(r2!.conceptUuid);
  });

  it('generates a valid UUID v4 format', () => {
    const result = toConcept(baseInput());
    expect(result).not.toBeNull();
    // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(result!.conceptUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sets firstSeen to the event occurredAt', () => {
    const occurredAt = new Date('2025-06-15T12:00:00.000Z');
    const result = toConcept(baseInput({ occurredAt }));
    expect(result).not.toBeNull();
    expect(result!.conceptInput.firstSeen).toEqual(occurredAt);
  });

  it('sets lastConfirmed to the event occurredAt for a new concept', () => {
    const occurredAt = new Date('2025-06-15T12:00:00.000Z');
    const result = toConcept(baseInput({ occurredAt }));
    expect(result).not.toBeNull();
    expect(result!.conceptInput.lastConfirmed).toEqual(occurredAt);
  });

  it('sets status to active for all new concepts', () => {
    const types = ['service', 'concept', 'decision', 'gotcha', 'convention', 'runbook'] as const;
    for (const type of types) {
      const input = baseInput({
        f1Output: validF1Output({ type }),
      });
      const result = toConcept(input);
      expect(result).not.toBeNull();
      expect(
        result!.conceptInput.status,
        `status should be 'active' for type ${type}`,
      ).toBe('active');
    }
  });

  it('sets schemaVersion to 1', () => {
    const result = toConcept(baseInput());
    expect(result).not.toBeNull();
    expect(result!.conceptInput.schemaVersion).toBe(1);
  });

  it('preserves F1 semantic content (type, title, body, path, tags, confidence)', () => {
    const f1Output = validF1Output({
      type: 'gotcha',
      title: 'Watch out for timezone bugs',
      body: 'Always store UTC.',
      path: 'gotchas/timezone-bugs',
      tags: ['timezone', 'bugs'],
      confidence: 'medium',
    });

    const result = toConcept(baseInput({ f1Output }));
    expect(result).not.toBeNull();
    const ci = result!.conceptInput;
    expect(ci.type).toBe('gotcha');
    expect(ci.title).toBe('Watch out for timezone bugs');
    expect(ci.body).toBe('Always store UTC.');
    expect(ci.path).toBe('gotchas/timezone-bugs');
    expect(ci.tags).toEqual(['timezone', 'bugs']);
    expect(ci.confidence).toBe('medium');
  });

  it('carries teamId and projectId scope', () => {
    const result = toConcept(
      baseInput({ teamId: 'team_scope_test', projectId: 'prj_scope_test' }),
    );
    expect(result).not.toBeNull();
    expect(result!.conceptInput.teamId).toBe('team_scope_test');
    expect(result!.conceptInput.projectId).toBe('prj_scope_test');
  });
});

// ── Boundary and edge cases ──────────────────────────────────────────────────

describe('toConcept — boundary and edge cases', () => {
  it('handles empty tags array', () => {
    const input = baseInput({
      f1Output: validF1Output({ tags: [] }),
    });
    const result = toConcept(input);
    expect(result).not.toBeNull();
    expect(result!.conceptInput.tags).toEqual([]);
  });

  it('handles low confidence', () => {
    const input = baseInput({
      f1Output: validF1Output({ confidence: 'low' }),
    });
    const result = toConcept(input);
    expect(result).not.toBeNull();
    expect(result!.conceptInput.confidence).toBe('low');
  });

  it('handles deep concept paths', () => {
    const input = baseInput({
      f1Output: validF1Output({ path: 'services/auth/api-gateway/rate-limiting' }),
    });
    const result = toConcept(input);
    expect(result).not.toBeNull();
    expect(result!.conceptInput.path).toBe('services/auth/api-gateway/rate-limiting');
  });

  it('handles all six concept types', () => {
    const types = ['service', 'concept', 'decision', 'gotcha', 'convention', 'runbook'] as const;
    for (const type of types) {
      const input = baseInput({
        f1Output: validF1Output({ type, path: `test/${type}-example` }),
      });
      const result = toConcept(input);
      expect(result, `toConcept should succeed for type "${type}"`).not.toBeNull();
      expect(result!.conceptInput.type).toBe(type);
    }
  });
});

// ── Frozen contract DTO validation for every evidence kind ───────────────────

describe('toConcept — frozen contract DTO acceptance', () => {
  it('cli_init aggregate passes concept DTO', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'cli',
        kind: 'cli_init',
        url: null,
        payload: {
          repo: 'teamem-ai/teamem',
          commitSha: 'abc1234def5678',
          path: 'src/index.ts',
          content: 'x',
          schemaVersion: 1,
        },
      }),
    );
  });

  it('github_commit aggregate passes concept DTO', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'github',
        kind: 'github_commit',
        url: 'https://github.com/teamem-ai/teamem/commit/abc1234',
      }),
    );
  });

  it('github_pr aggregate passes concept DTO', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'github',
        kind: 'github_pr',
        url: 'https://github.com/teamem-ai/teamem/pull/42',
      }),
    );
  });

  it('github_issue aggregate passes concept DTO', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'github',
        kind: 'github_issue',
        url: 'https://github.com/teamem-ai/teamem/issues/99',
      }),
    );
  });

  it('github_pr_comment aggregate passes concept DTO', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'github',
        kind: 'github_pr_comment',
        url: 'https://github.com/teamem-ai/teamem/pull/42#discussion_r123',
      }),
    );
  });

  it('mcp_write aggregate passes concept DTO', () => {
    validateAgainstConceptDto(
      baseInput({
        channel: 'mcp',
        kind: 'mcp_write',
        url: null,
        eventId: 'evt_mcp_12345',
      }),
    );
  });
});
