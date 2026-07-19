/**
 * GitHub connector common helpers — unit tests (DUA-142).
 *
 * Tests the three required fixture categories (human, bot/service, missing
 * sender) plus the login-change-must-not-change-identity acceptance criterion.
 * No database dependency — pure function validation.
 */
import { describe, expect, it } from 'vitest';
import {
  extractDeliveryId,
  extractInstallationId,
  extractRepositoryFullName,
  githubActorProvenance,
  githubCommitUrl,
  githubIssueUrl,
  githubOccurredAtProvenance,
  githubPullRequestUrl,
  githubRepositoryUrl,
  mapGithubEventKind,
  normalizeGithubActor,
  extractGithubItemKey,
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
} from './common.js';
import type { GithubSender } from './common.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const humanSender: GithubSender = {
  login: 'octocat',
  id: 583231,
  type: 'User',
};

const botSender: GithubSender = {
  login: 'dependabot[bot]',
  id: 49699333,
  type: 'Bot',
};

const organizationSender: GithubSender = {
  login: 'github',
  id: 9919,
  type: 'Organization',
};

// ── normalizeGithubActor ──────────────────────────────────────────────────────

describe('normalizeGithubActor', () => {
  describe('success paths', () => {
    it('human sender: kind=human, provider=github, providerUserId=numeric id (string)', () => {
      const result = normalizeGithubActor(humanSender);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe('human');
      expect(result!.provider).toBe('github');
      expect(result!.providerUserId).toBe('583231');
      expect(result!.displayLogin).toBe('octocat');
    });

    it('bot sender: kind=service, provider=github, providerUserId=numeric id (string)', () => {
      const result = normalizeGithubActor(botSender);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe('service');
      expect(result!.provider).toBe('github');
      expect(result!.providerUserId).toBe('49699333');
      expect(result!.displayLogin).toBe('dependabot[bot]');
    });

    it('organization sender: kind=service (not User type → service)', () => {
      const result = normalizeGithubActor(organizationSender);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe('service');
      expect(result!.provider).toBe('github');
      expect(result!.providerUserId).toBe('9919');
    });
  });

  describe('missing sender — never fabricated (N2)', () => {
    it('undefined sender → null', () => {
      expect(normalizeGithubActor(undefined)).toBeNull();
    });

    it('null sender → null', () => {
      expect(normalizeGithubActor(null)).toBeNull();
    });

    it('sender without id → null (numeric ID is the stable identity anchor)', () => {
      expect(normalizeGithubActor({ login: 'ghost', type: 'User' })).toBeNull();
    });

    it('sender with id=0 (falsy but valid) → still maps — 0 is a valid GitHub ID for some legacy accounts', () => {
      // GitHub IDs are positive integers in practice, but id=0 is falsy in
      // JS. We guard against undefined/null, not 0, because the contract
      // specifies "numeric id" not "positive integer".
      const result = normalizeGithubActor({ id: 0, type: 'User' });
      expect(result).not.toBeNull();
      expect(result!.providerUserId).toBe('0');
    });

    it('sender with id present but type missing → kind=service (default to service for unknown type)', () => {
      const result = normalizeGithubActor({ id: 123 });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('service');
    });
  });

  describe('login change must not change provider user ID (CLI acceptance criterion)', () => {
    it('same numeric id with different login → same providerUserId, different displayLogin', () => {
      const before = normalizeGithubActor({ login: 'old-name', id: 583231, type: 'User' });
      const after = normalizeGithubActor({ login: 'new-name', id: 583231, type: 'User' });

      expect(before!.providerUserId).toBe(after!.providerUserId);
      expect(before!.displayLogin).toBe('old-name');
      expect(after!.displayLogin).toBe('new-name');
    });

    it('login change does not affect kind', () => {
      const a = normalizeGithubActor({ login: 'a', id: 1, type: 'Bot' });
      const b = normalizeGithubActor({ login: 'b', id: 1, type: 'Bot' });
      expect(a!.kind).toBe(b!.kind);
    });
  });

  describe('boundary / counterexample', () => {
    it('empty-string login is accepted (GitHub allows this in theory; login is display-only)', () => {
      const result = normalizeGithubActor({ login: '', id: 1, type: 'User' });
      expect(result).not.toBeNull();
      expect(result!.displayLogin).toBe('');
    });

    it('numeric id is stringified, not truncated or rounded', () => {
      const bigId = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
      const result = normalizeGithubActor({ id: bigId, type: 'User' });
      expect(result!.providerUserId).toBe(String(bigId));
    });
  });
});

// ── githubActorProvenance ─────────────────────────────────────────────────────

describe('githubActorProvenance', () => {
  it('webhookVerified=true → webhook_verified', () => {
    expect(githubActorProvenance(true)).toBe('webhook_verified');
  });

  it('webhookVerified=false → unknown (never client_claimed for internal connectors)', () => {
    expect(githubActorProvenance(false)).toBe('unknown');
  });
});

// ── githubOccurredAtProvenance ────────────────────────────────────────────────

describe('githubOccurredAtProvenance', () => {
  it('hasProviderTimestamp=true → provider', () => {
    expect(githubOccurredAtProvenance(true)).toBe('provider');
  });

  it('hasProviderTimestamp=false → server', () => {
    expect(githubOccurredAtProvenance(false)).toBe('server');
  });
});

// ── extractDeliveryId ─────────────────────────────────────────────────────────

describe('extractDeliveryId', () => {
  it('extracts x-github-delivery from headers', () => {
    const headers = { [GITHUB_DELIVERY_HEADER]: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' };
    expect(extractDeliveryId(headers)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('trims whitespace from delivery ID', () => {
    const headers = { [GITHUB_DELIVERY_HEADER]: '  abc-def  ' };
    expect(extractDeliveryId(headers)).toBe('abc-def');
  });

  it('missing header → undefined', () => {
    expect(extractDeliveryId({})).toBeUndefined();
  });

  it('empty string header → undefined', () => {
    expect(extractDeliveryId({ [GITHUB_DELIVERY_HEADER]: '' })).toBeUndefined();
  });

  it('whitespace-only header → undefined', () => {
    expect(extractDeliveryId({ [GITHUB_DELIVERY_HEADER]: '   ' })).toBeUndefined();
  });
});

// ── extractInstallationId ─────────────────────────────────────────────────────

describe('extractInstallationId', () => {
  it('extracts installation.id from payload', () => {
    const payload = { installation: { id: 12345, account: {} } };
    expect(extractInstallationId(payload)).toBe('12345');
  });

  it('missing installation → undefined', () => {
    expect(extractInstallationId({})).toBeUndefined();
  });

  it('installation without id → undefined', () => {
    expect(extractInstallationId({ installation: {} })).toBeUndefined();
  });
});

// ── extractRepositoryFullName ─────────────────────────────────────────────────

describe('extractRepositoryFullName', () => {
  it('extracts full_name from repository object', () => {
    const payload = { repository: { full_name: 'octocat/Hello-World', owner: { login: 'octocat' }, name: 'Hello-World' } };
    expect(extractRepositoryFullName(payload)).toBe('octocat/Hello-World');
  });

  it('constructs full_name from owner.login + name when full_name is absent', () => {
    const payload = { repository: { owner: { login: 'octocat' }, name: 'Hello-World' } };
    expect(extractRepositoryFullName(payload)).toBe('octocat/Hello-World');
  });

  it('missing repository → undefined', () => {
    expect(extractRepositoryFullName({})).toBeUndefined();
  });

  it('incomplete repository (no owner login) → undefined', () => {
    expect(extractRepositoryFullName({ repository: { name: 'repo' } })).toBeUndefined();
  });
});

// ── Canonical URL construction ────────────────────────────────────────────────

describe('canonical URLs', () => {
  it('githubCommitUrl builds correct URL', () => {
    expect(githubCommitUrl('octocat', 'Hello-World', 'abc123def')).toBe(
      'https://github.com/octocat/Hello-World/commit/abc123def',
    );
  });

  it('githubPullRequestUrl builds correct URL', () => {
    expect(githubPullRequestUrl('octocat', 'Hello-World', 42)).toBe(
      'https://github.com/octocat/Hello-World/pull/42',
    );
  });

  it('githubIssueUrl builds correct URL', () => {
    expect(githubIssueUrl('octocat', 'Hello-World', 7)).toBe(
      'https://github.com/octocat/Hello-World/issues/7',
    );
  });

  it('githubRepositoryUrl builds correct URL', () => {
    expect(githubRepositoryUrl('octocat', 'Hello-World')).toBe(
      'https://github.com/octocat/Hello-World',
    );
  });
});

// ── mapGithubEventKind ────────────────────────────────────────────────────────

describe('mapGithubEventKind', () => {
  it('push → github_commit', () => {
    expect(mapGithubEventKind('push')).toBe('github_commit');
  });

  it('pull_request → github_pr', () => {
    expect(mapGithubEventKind('pull_request')).toBe('github_pr');
  });

  it('issues → github_issue', () => {
    expect(mapGithubEventKind('issues')).toBe('github_issue');
  });

  it('issue_comment → github_pr_comment', () => {
    expect(mapGithubEventKind('issue_comment')).toBe('github_pr_comment');
  });

  it('pull_request_review_comment → github_pr_comment', () => {
    expect(mapGithubEventKind('pull_request_review_comment')).toBe('github_pr_comment');
  });

  it('pull_request_review → github_pr_comment', () => {
    expect(mapGithubEventKind('pull_request_review')).toBe('github_pr_comment');
  });

  it('unhandled event type → undefined (caller must skip, not silently drop)', () => {
    expect(mapGithubEventKind('workflow_run')).toBeUndefined();
    expect(mapGithubEventKind('star')).toBeUndefined();
    expect(mapGithubEventKind('unknown_event')).toBeUndefined();
  });
});

// ── extractGithubItemKey ──────────────────────────────────────────────────────

describe('extractGithubItemKey', () => {
  it('push event: itemKey = after SHA', () => {
    const payload = { after: 'abc123' };
    expect(extractGithubItemKey('push', payload)).toBe('abc123');
  });

  it('push event: missing after → root', () => {
    expect(extractGithubItemKey('push', {})).toBe('root');
  });

  it('pull_request event: itemKey = PR number', () => {
    const payload = { pull_request: { number: 42 } };
    expect(extractGithubItemKey('pull_request', payload)).toBe('42');
  });

  it('pull_request event: missing pull_request → root', () => {
    expect(extractGithubItemKey('pull_request', {})).toBe('root');
  });

  it('issues event: itemKey = issue number', () => {
    const payload = { issue: { number: 7 } };
    expect(extractGithubItemKey('issues', payload)).toBe('7');
  });

  it('issue_comment event: itemKey = comment id', () => {
    const payload = { comment: { id: 999 } };
    expect(extractGithubItemKey('issue_comment', payload)).toBe('999');
  });

  it('unknown event type → root', () => {
    expect(extractGithubItemKey('workflow_run', {})).toBe('root');
  });
});

// ── Header constant values ────────────────────────────────────────────────────

describe('header constants', () => {
  it('GITHUB_DELIVERY_HEADER is lowercase x-github-delivery', () => {
    expect(GITHUB_DELIVERY_HEADER).toBe('x-github-delivery');
  });

  it('GITHUB_EVENT_HEADER is lowercase x-github-event', () => {
    expect(GITHUB_EVENT_HEADER).toBe('x-github-event');
  });

  it('GITHUB_SIGNATURE_HEADER is lowercase x-hub-signature-256', () => {
    expect(GITHUB_SIGNATURE_HEADER).toBe('x-hub-signature-256');
  });
});
