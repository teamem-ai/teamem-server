/**
 * F1 deterministic skip filter — unit tests.
 *
 * Validates the prefilterNoise function against noisy and valuable fixtures.
 * No database required — pure function tests.
 *
 * CLI acceptance:
 *   - Noisy fixtures (e.g. "fix typo", "bump deps") → skip with reason
 *   - Valuable fixtures (e.g. "决定用令牌桶限流") → not skipped (null)
 *   - Skip output passes Zod (missing reason rejected)
 */
import { describe, expect, it } from 'vitest';
import { prefilterNoise } from './skip-filter.js';
import { f1Output } from './output.js';

// ── Noisy fixtures (expected: skip with reason) ────────────────────────────

describe('prefilterNoise — noisy fixtures (should skip)', () => {
  it('skips "fix typo" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'fix typo',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(result!.reason).toContain('fix typo');
    // Must pass Zod validation.
    expect(f1Output.safeParse(result).success).toBe(true);
  });

  it('skips "fix typo in foo.ts" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'fix typo in foo.ts',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(f1Output.safeParse(result).success).toBe(true);
  });

  it('skips "asdf" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'asdf',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(f1Output.safeParse(result).success).toBe(true);
  });

  it('skips "WIP" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'WIP',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(f1Output.safeParse(result).success).toBe(true);
  });

  it('skips "test" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'test',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "tmp" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'tmp',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips emoji-only commit 🚀', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: '🚀',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(f1Output.safeParse(result).success).toBe(true);
  });

  it('skips whitespace-only commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: '  ',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(f1Output.safeParse(result).success).toBe(true);
  });

  it('skips empty commit message', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: '',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "." commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: '.',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "update README" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'update README',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "update docs" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'update docs',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "fix lint" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'fix lint',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "fix format" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'fix format',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "cleanup" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'cleanup',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips Dependabot bump commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: `Bump eslint from 8.57.0 to 8.57.1

---
updated-dependencies:
- dependency-name: eslint
  dependency-type: direct:development
...

Signed-off-by: dependabot[bot] <support@github.com>`,
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(result!.reason).toContain('dependency bump');
  });

  it('skips "build(deps): bump X" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'build(deps): bump serde from 1.0.1 to 1.0.2',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips Renovate bump commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'Update dependency typescript to v5.5.0 (renovate)',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips merge commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: "Merge branch 'feature/auth' into main",
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(result!.reason).toContain('merge commit');
  });

  it('skips merge pull request commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'Merge pull request #42 from teamem-ai/feature/oauth',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips version-only tag "v1.2.3"', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'v1.2.3',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips version-only tag "1.0.0"', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: '1.0.0',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips empty PR comment', () => {
    const result = prefilterNoise('github', 'github_pr_comment', {
      body: '',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "LGTM" PR comment', () => {
    const result = prefilterNoise('github', 'github_pr_comment', {
      body: 'LGTM',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips thumbs-up emoji PR comment', () => {
    const result = prefilterNoise('github', 'github_pr_comment', {
      body: '👍',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips Dependabot PR (title-based)', () => {
    const result = prefilterNoise('github', 'github_pr', {
      title: 'Bump axios from 1.6.0 to 1.7.0',
      body: 'Auto-generated dependabot PR.',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
    expect(result!.reason).toContain('dependency bump');
  });

  it('skips chore: update eslint config PR with minimal body', () => {
    const result = prefilterNoise('github', 'github_pr', {
      title: 'chore: update eslint config',
      body: 'Updated config.',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips CLI init with empty content', () => {
    const result = prefilterNoise('cli', 'cli_init', {
      repo: 'teamem-ai/teamem',
      commitSha: 'abc1234def',
      path: 'docs/empty.md',
      content: '',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "code review" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'code review',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "fix build" commit', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'fix build',
      sha: 'abc1234',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });
});

// ── Valuable fixtures (expected: pass through — no skip) ───────────────────

describe('prefilterNoise — valuable fixtures (should NOT skip)', () => {
  it('does NOT skip commit with rationale', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: `feat(db): add connection pooling for Postgres

Using PgBouncer in transaction mode reduces connection overhead by 40%
under our peak load of ~500 req/s. This is a stopgap until we can move
to serverless Postgres in Q3.`,
      sha: 'abc1234',
    });
    expect(result).toBeNull();
  });

  it('does NOT skip commit about architecture decision', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: '决定用令牌桶限流',
      sha: 'abc1234',
    });
    expect(result).toBeNull();
  });

  it('does NOT skip commit with ADR', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: `docs(adr): add ADR-003 — use event sourcing for audit log

## Decision
We will use event sourcing for the audit log instead of a traditional
append-only table.`,
      sha: 'abc1234',
    });
    expect(result).toBeNull();
  });

  it('does NOT skip meaningful PR body', () => {
    const result = prefilterNoise('github', 'github_pr', {
      title: 'feat: add token bucket rate limiter',
      body: '## Summary\n\nImplements a token bucket rate limiter for the API gateway.\n\n## Rationale\n\nWe need to protect downstream services from traffic spikes.',
    });
    expect(result).toBeNull();
  });

  it('does NOT skip issue with substantive body', () => {
    const result = prefilterNoise('github', 'github_issue', {
      title: 'PROD: payment webhook timeout',
      body: 'The payment webhook from Stripe times out after 30s.',
    });
    expect(result).toBeNull();
  });

  it('does NOT skip PR comment with design discussion', () => {
    const result = prefilterNoise('github', 'github_pr_comment', {
      body: 'I think we should use the Strategy pattern here instead of a switch statement. The current implementation has a switch with 5 cases, and each case is ~50 lines of provider-specific logic.',
    });
    expect(result).toBeNull();
  });

  it('does NOT skip CLI init with content', () => {
    const result = prefilterNoise('cli', 'cli_init', {
      repo: 'teamem-ai/teamem',
      commitSha: 'abc1234def',
      path: 'docs/runbook.md',
      content: '# Payment Worker\n\n## Overview\nProcesses payment events.',
    });
    expect(result).toBeNull();
  });

  it('does NOT skip normal commit with meaningful message', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 'fix(api): handle edge case where user has no team membership',
      sha: 'abc1234',
    });
    expect(result).toBeNull();
  });

  it('does NOT skip PR with long body even if title matches mechanical pattern', () => {
    // chore title but substantial body — not obviously noise.
    const result = prefilterNoise('github', 'github_pr', {
      title: 'chore: update eslint config',
      body: 'This change adds a new rule requiring explicit return types on exported functions. We discussed this in the team meeting on Monday and agreed it improves maintainability. See slack thread for full discussion.',
    });
    // Body is > 100 chars → the filter lets it through for LLM to decide.
    expect(result).toBeNull();
  });

  it('does NOT skip non-github channels (unknown kind)', () => {
    const result = prefilterNoise('mcp', 'mcp_write', {
      content: 'We decided to use Postgres.',
    });
    expect(result).toBeNull();
  });
});

// ── Zod validation: skip output must pass f1Output schema ──────────────────

describe('prefilterNoise — Zod compatibility', () => {
  it('every skip result passes f1Output Zod validation', () => {
    const noisyFixtures: Array<{
      channel: string;
      kind: string;
      payload: Record<string, unknown>;
    }> = [
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: 'fix typo', sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: 'asdf', sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: 'WIP', sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: 'Bump eslint from 8.57.0 to 8.57.1', sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: "Merge branch 'x' into y", sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: 'v1.2.3', sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: '🚀', sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: '  ', sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_commit',
        payload: { message: 'update README', sha: 'abc' },
      },
      {
        channel: 'github',
        kind: 'github_pr_comment',
        payload: { body: 'LGTM' },
      },
      {
        channel: 'github',
        kind: 'github_pr',
        payload: { title: 'Bump axios from 1.6.0 to 1.7.0', body: 'Auto' },
      },
      {
        channel: 'cli',
        kind: 'cli_init',
        payload: { content: '' },
      },
    ];

    for (const fixture of noisyFixtures) {
      const result = prefilterNoise(fixture.channel, fixture.kind, fixture.payload);
      expect(result).not.toBeNull();
      const parseResult = f1Output.safeParse(result);
      expect(
        parseResult.success,
        `Skip result for "${JSON.stringify(fixture.payload).slice(0, 100)}" failed Zod: ${JSON.stringify(parseResult.error?.issues ?? 'unknown')}`,
      ).toBe(true);
    }
  });

  it('skip without reason would be rejected by Zod', () => {
    // Simulate what would happen if the filter returned skip without reason.
    const invalidSkip = { action: 'skip' };
    const result = f1Output.safeParse(invalidSkip);
    expect(result.success).toBe(false);
  });

  it('skip with empty reason would be rejected by Zod', () => {
    const invalidSkip = { action: 'skip', reason: '' };
    const result = f1Output.safeParse(invalidSkip);
    expect(result.success).toBe(false);
  });

  it('skip with reason exceeding 500 chars would be rejected by Zod', () => {
    const longReason = 'x'.repeat(501);
    const invalidSkip = { action: 'skip', reason: longReason };
    const result = f1Output.safeParse(invalidSkip);
    expect(result.success).toBe(false);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('prefilterNoise — edge cases', () => {
  it('returns null for null/undefined message', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: null,
      sha: 'abc1234',
    });
    expect(result).toBeNull();
  });

  it('returns null for missing message field', () => {
    const result = prefilterNoise('github', 'github_commit', {
      sha: 'abc1234',
    });
    expect(result).toBeNull();
  });

  it('returns null for non-string message', () => {
    const result = prefilterNoise('github', 'github_commit', {
      message: 42,
      sha: 'abc1234',
    });
    expect(result).toBeNull();
  });

  it('returns null for unknown channel/kind combination', () => {
    const result = prefilterNoise('unknown_channel', 'unknown_kind', {
      data: 'something',
    });
    expect(result).toBeNull();
  });

  it('does not skip question-only issue (could be genuine)', () => {
    const result = prefilterNoise('github', 'github_issue', {
      title: 'question: how do I set up the dev environment?',
      body: '',
    });
    expect(result).toBeNull();
  });

  it('skips vague issue with short title and empty body', () => {
    const result = prefilterNoise('github', 'github_issue', {
      title: 'update',
      body: '',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "ship it" PR comment', () => {
    const result = prefilterNoise('github', 'github_pr_comment', {
      body: 'ship it',
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('skip');
  });

  it('skips "done" PR comment', () => {
    const result = prefilterNoise('github', 'github_pr_comment', {
      body: 'done',
    });
    expect(result).not.toBeNull();
  });

  it('"fix test" (singular) is not restricted — could be substantive', () => {
    // "fix test" is vague enough that we don't want to skip it.
    // Our pattern only matches "fix tests" (plural) or "fix test" with
    // more context.
    const result = prefilterNoise('github', 'github_commit', {
      message: 'fix test for payment edge case',
      sha: 'abc1234',
    });
    // "fix test for payment edge case" does not match our exact pattern "fix test" or "fix tests".
    // Let's verify: we have /^fix tests$/i which requires exact match "fix tests".
    // "fix test for payment edge case" has more text after, so it won't match.
    expect(result).toBeNull();
  });
});
