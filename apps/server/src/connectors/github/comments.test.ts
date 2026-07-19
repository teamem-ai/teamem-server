/**
 * GitHub PR-review / issue-comment normalizer — unit tests (DUA-146).
 *
 * Pure-function validation: no database, no network. Fixtures are redacted
 * (no `<private>` content) for the success paths, per the task's work
 * boundary ("评论解析器及脱敏后的 fixture"). One boundary case explicitly
 * asserts the parser DEFERS redaction to the ingestion layer (§5.3 order),
 * proving the connector does not duplicate the strip step nor leak by
 * prematurely removing evidence.
 *
 * CLI acceptance coverage:
 *   1. comment parser tests run (this file).
 *   2. edited / re-delivered comments keep a stable item identity.
 *   3. comment permalink is immutable evidence (derived from stable id).
 */
import { describe, expect, it } from 'vitest';
import { normalizedEventSchema } from '../registry.js';
import {
  githubCommentAnchor,
  githubCommentPermalink,
  isHandledCommentEvent,
  normalizeCommentEvent,
  normalizeGithubTimestamp,
  resolveCommentPermalink,
} from './comments.js';

// ── Shared redacted fixtures ─────────────────────────────────────────────────
// Repository identity: octocat/Hello-World. No `<private>` content.

const DELIVERY = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SERVER_TIME = '2024-01-15T10:30:00.000Z';

const issueCommentCreatedPayload = {
  action: 'created',
  issue: {
    number: 7,
    html_url: 'https://github.com/octocat/Hello-World/issues/7',
    title: 'Bug: thing breaks',
    user: { login: 'octocat', id: 583231, type: 'User' },
  },
  comment: {
    id: 123456789,
    body: 'This happens because the queue is drained before the flush. See #42.',
    created_at: '2024-01-15T10:00:00Z',
    updated_at: '2024-01-15T10:00:00Z',
    html_url: 'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
    user: { login: 'octocat', id: 583231, type: 'User' },
  },
  repository: {
    full_name: 'octocat/Hello-World',
    owner: { login: 'octocat' },
    name: 'Hello-World',
  },
  sender: { login: 'octocat', id: 583231, type: 'User' },
  installation: { id: 424242 },
};

const issueCommentOnPrPayload = {
  action: 'created',
  issue: {
    number: 42,
    pull_request: { url: 'https://api.github.com/repos/octocat/Hello-World/pulls/42' },
    html_url: 'https://github.com/octocat/Hello-World/pull/42',
  },
  comment: {
    id: 555,
    body: 'The reason we guard here is the empty-batch case.',
    created_at: '2024-02-01T09:00:00Z',
    updated_at: '2024-02-01T09:00:00Z',
    html_url: 'https://github.com/octocat/Hello-World/pull/42#issuecomment-555',
    user: { login: 'reviewer', id: 7, type: 'User' },
  },
  repository: { full_name: 'octocat/Hello-World' },
  sender: { login: 'reviewer', id: 7, type: 'User' },
};

const reviewCommentCreatedPayload = {
  action: 'created',
  pull_request: { number: 42, html_url: 'https://github.com/octocat/Hello-World/pull/42' },
  comment: {
    id: 987654,
    body: 'Why a mutex here and not a channel?',
    path: 'src/queue.ts',
    line: 30,
    created_at: '2024-02-02T12:00:00Z',
    updated_at: '2024-02-02T12:00:00Z',
    html_url:
      'https://github.com/octocat/Hello-World/pull/42#discussion_r987654',
    user: { login: 'reviewer', id: 7, type: 'User' },
  },
  repository: { full_name: 'octocat/Hello-World' },
  sender: { login: 'reviewer', id: 7, type: 'User' },
};

const reviewSubmittedPayload = {
  action: 'submitted',
  pull_request: { number: 42, html_url: 'https://github.com/octocat/Hello-World/pull/42' },
  review: {
    id: 888111,
    body: 'Approve: the guard is correct because the batch can be empty.',
    state: 'approved',
    submitted_at: '2024-02-03T08:00:00Z',
    html_url:
      'https://github.com/octocat/Hello-World/pull/42#pullrequestreview-888111',
    user: { login: 'reviewer', id: 7, type: 'User' },
  },
  repository: { full_name: 'octocat/Hello-World' },
  sender: { login: 'reviewer', id: 7, type: 'User' },
};

// ── isHandledCommentEvent ──────────────────────────────────────────────────

describe('isHandledCommentEvent', () => {
  it('recognizes the three handled events', () => {
    expect(isHandledCommentEvent('issue_comment')).toBe(true);
    expect(isHandledCommentEvent('pull_request_review')).toBe(true);
    expect(isHandledCommentEvent('pull_request_review_comment')).toBe(true);
  });
  it('rejects unhandled events', () => {
    expect(isHandledCommentEvent('push')).toBe(false);
    expect(isHandledCommentEvent('pull_request')).toBe(false);
    expect(isHandledCommentEvent('workflow_run')).toBe(false);
  });
});

// ── normalizeGithubTimestamp ───────────────────────────────────────────────

describe('normalizeGithubTimestamp', () => {
  it('normalizes GitHub zero-precision time to frozen ms precision', () => {
    expect(normalizeGithubTimestamp('2024-01-15T10:30:00Z')).toBe(
      '2024-01-15T10:30:00.000Z',
    );
  });
  it('normalizes microsecond precision down to milliseconds', () => {
    expect(normalizeGithubTimestamp('2024-01-15T10:30:00.123456Z')).toBe(
      '2024-01-15T10:30:00.123Z',
    );
  });
  it('absent value → undefined (server fallback by the normalizer)', () => {
    expect(normalizeGithubTimestamp(undefined)).toBeUndefined();
    expect(normalizeGithubTimestamp(null)).toBeUndefined();
    expect(normalizeGithubTimestamp('')).toBeUndefined();
  });
  it('unparseable value → undefined', () => {
    expect(normalizeGithubTimestamp('not-a-date')).toBeUndefined();
  });
});

// ── Success paths: normalization output ─────────────────────────────────────

describe('normalizeCommentEvent — success paths', () => {
  it('issue_comment.created on an issue: frozen kind, parent ref, actor, action, provider time', () => {
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: issueCommentCreatedPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    });
    expect(ev).not.toBeNull();
    expect(ev!.connectorKind).toBe('github');
    expect(ev!.eventKind).toBe('github_pr_comment');
    expect(ev!.sourceEvent).toBe('issue_comment');
    expect(ev!.sourceAction).toBe('created');
    expect(ev!.itemKey).toBe('123456789');
    expect(ev!.externalId).toBe('octocat/Hello-World#issuecomment-123456789');
    expect(ev!.url).toBe(
      'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
    );
    // actor preserved verbatim; webhook_verified earned (N2)
    expect(ev!.actor).toEqual({
      kind: 'human',
      provider: 'github',
      providerUserId: '583231',
      displayLogin: 'octocat',
    });
    expect(ev!.actorProvenance).toBe('webhook_verified');
    expect(ev!.occurredAt).toBe('2024-01-15T10:00:00.000Z');
    expect(ev!.occurredAtProvenance).toBe('provider');
    // parent reference + immutable permalink preserved in payload
    expect(ev!.payload).toMatchObject({
      parentType: 'issue',
      parentNumber: 7,
      parentUrl: 'https://github.com/octocat/Hello-World/issues/7',
      commentId: 123456789,
      commentUrl:
        'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
      commentHtmlUrl:
        'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
      action: 'created',
      rawEvent: 'issue_comment',
      body: issueCommentCreatedPayload.comment.body,
      installationId: '424242',
    });
  });

  it('issue_comment on a PR (issue.pull_request present): parentType=pull_request, permalink uses /pull/', () => {
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: issueCommentOnPrPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    });
    expect(ev).not.toBeNull();
    expect(ev!.payload['parentType']).toBe('pull_request');
    expect(ev!.payload['parentNumber']).toBe(42);
    expect(ev!.url).toBe(
      'https://github.com/octocat/Hello-World/pull/42#issuecomment-555',
    );
  });

  it('pull_request_review_comment.created: discussion_r anchor, parent PR', () => {
    const ev = normalizeCommentEvent({
      githubEvent: 'pull_request_review_comment',
      payload: reviewCommentCreatedPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    });
    expect(ev).not.toBeNull();
    expect(ev!.eventKind).toBe('github_pr_comment');
    expect(ev!.sourceEvent).toBe('pull_request_review_comment');
    expect(ev!.itemKey).toBe('987654');
    expect(ev!.url).toBe(
      'https://github.com/octocat/Hello-World/pull/42#discussion_r987654',
    );
    expect(ev!.externalId).toBe('octocat/Hello-World#discussion_r987654');
    expect(ev!.payload).toMatchObject({
      parentType: 'pull_request',
      parentNumber: 42,
      commentId: 987654,
      commentUrl: 'https://github.com/octocat/Hello-World/pull/42#discussion_r987654',
    });
    expect(ev!.payload['reviewState']).toBeUndefined();
  });

  it('pull_request_review.submitted: review anchor, reviewState preserved, provider time from submitted_at', () => {
    const ev = normalizeCommentEvent({
      githubEvent: 'pull_request_review',
      payload: reviewSubmittedPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    });
    expect(ev).not.toBeNull();
    expect(ev!.eventKind).toBe('github_pr_comment');
    expect(ev!.sourceEvent).toBe('pull_request_review');
    expect(ev!.sourceAction).toBe('submitted');
    expect(ev!.itemKey).toBe('888111');
    expect(ev!.url).toBe(
      'https://github.com/octocat/Hello-World/pull/42#pullrequestreview-888111',
    );
    expect(ev!.occurredAt).toBe('2024-02-03T08:00:00.000Z');
    expect(ev!.occurredAtProvenance).toBe('provider');
    expect(ev!.payload).toMatchObject({
      commentId: 888111,
      reviewState: 'approved',
      parentUrl: 'https://github.com/octocat/Hello-World/pull/42',
      commentUrl:
        'https://github.com/octocat/Hello-World/pull/42#pullrequestreview-888111',
    });
  });

  it('pull_request_review.edited: does NOT reuse submitted_at; uses updated_at', () => {
    const edited = {
      ...reviewSubmittedPayload,
      action: 'edited',
      review: {
        ...reviewSubmittedPayload.review,
        updated_at: '2024-02-03T12:00:00Z', // edit time
        dismissed_at: undefined,
      },
    };
    const ev = normalizeCommentEvent({
      githubEvent: 'pull_request_review',
      payload: edited,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(ev.sourceAction).toBe('edited');
    expect(ev.occurredAt).toBe('2024-02-03T12:00:00.000Z');
    expect(ev.occurredAtProvenance).toBe('provider');
  });

  it('pull_request_review.dismissed: no updated_at/dismissed_at → server time with server provenance', () => {
    const dismissed = {
      ...reviewSubmittedPayload,
      action: 'dismissed',
      review: {
        ...reviewSubmittedPayload.review,
        updated_at: undefined,
        dismissed_at: undefined,
      },
    };
    const ev = normalizeCommentEvent({
      githubEvent: 'pull_request_review',
      payload: dismissed,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(ev.sourceAction).toBe('dismissed');
    // submitted_at is the original submission time and must NOT be used for
    // the dismissal event (P1). With no reliable provider change timestamp,
    // we fall back to server time.
    expect(ev.occurredAt).toBe(SERVER_TIME);
    expect(ev.occurredAtProvenance).toBe('server');
  });

  it('every produced event passes the frozen NormalizedEvent Zod contract', () => {
    for (const [name, githubEvent, payload] of [
      ['issue_comment', 'issue_comment', issueCommentCreatedPayload],
      ['pr comment on issue event', 'issue_comment', issueCommentOnPrPayload],
      ['review comment', 'pull_request_review_comment', reviewCommentCreatedPayload],
      ['review submitted', 'pull_request_review', reviewSubmittedPayload],
    ] as const) {
      const ev = normalizeCommentEvent({
        githubEvent,
        payload: payload as Record<string, unknown>,
        deliveryId: DELIVERY,
        webhookVerified: true,
        serverTime: SERVER_TIME,
      });
      const parsed = normalizedEventSchema.safeParse(ev);
      expect(parsed.success, `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });
});

// ── CLI #2: stable item identity across edit / redelivery ────────────────────

describe('CLI #2 — stable item identity across edit & redelivery', () => {
  const editedPayload = {
    action: 'edited',
    issue: issueCommentCreatedPayload.issue,
    comment: {
      id: 123456789, // SAME id
      body: 'Edited: the queue is drained before the flush, not after.',
      created_at: '2024-01-15T10:00:00Z',
      updated_at: '2024-01-15T11:00:00Z', // edit time
      html_url:
        'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
      user: { login: 'octocat', id: 583231, type: 'User' },
    },
    repository: issueCommentCreatedPayload.repository,
    sender: { login: 'octocat', id: 583231, type: 'User' },
  };

  it('edited comment keeps the same itemKey and permalink as the original', () => {
    const original = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: issueCommentCreatedPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    const edited = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: editedPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;

    expect(edited.itemKey).toBe(original.itemKey); // stable identity
    expect(edited.url).toBe(original.url); // immutable permalink
    expect(edited.externalId).toBe(original.externalId);
    // action + provider time reflect the edit event (occurred_at = updated_at)
    expect(edited.sourceAction).toBe('edited');
    expect(edited.occurredAt).toBe('2024-01-15T11:00:00.000Z');
    expect(edited.payload['body']).not.toEqual(original.payload['body']);
  });

  it('re-delivered (different delivery id) comment keeps the same itemKey', () => {
    const original = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: issueCommentCreatedPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    const redelivered = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: issueCommentCreatedPayload,
      deliveryId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', // different delivery
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;

    // Redelivery changes the delivery id (idempotency identity component) but
    // the per-item identity — itemKey + permalink + externalId — is stable
    // because it is anchored on the immutable GitHub comment id.
    expect(redelivered.itemKey).toBe(original.itemKey);
    expect(redelivered.url).toBe(original.url);
    expect(redelivered.externalId).toBe(original.externalId);
    expect(redelivered.deliveryId).not.toBe(original.deliveryId);
  });
});

// ── CLI #3: permalink is immutable evidence ──────────────────────────────────

describe('CLI #3 — comment permalink is immutable evidence', () => {
  it('permalink is reconstructable from stable repo + parent + id', () => {
    const constructed = githubCommentPermalink(
      'octocat/Hello-World',
      'issue',
      7,
      'issue_comment',
      123456789,
    );
    expect(constructed).toBe(
      'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
    );
    // The normalizer's url matches the construction derived from the id.
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: { ...issueCommentCreatedPayload, comment: { ...issueCommentCreatedPayload.comment, html_url: undefined } },
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(ev.url).toBe(constructed);
  });

  it('permalink is independent of the mutable comment body', () => {
    const a = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: issueCommentCreatedPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    const b = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: {
        ...issueCommentCreatedPayload,
        comment: { ...issueCommentCreatedPayload.comment, body: 'completely different body' },
      },
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(a.url).toBe(b.url);
    expect(a.itemKey).toBe(b.itemKey);
  });

  it('githubCommentAnchor: stable fragment per event type', () => {
    expect(githubCommentAnchor('issue_comment', 1)).toBe('#issuecomment-1');
    expect(githubCommentAnchor('pull_request_review_comment', 2)).toBe('#discussion_r2');
    expect(githubCommentAnchor('pull_request_review', 3)).toBe('#pullrequestreview-3');
  });

  it('raw html_url is accepted only when it matches normalized facts (P2)', () => {
    // Wrong repo — should fall back to deterministic construction.
    const wrongRepo = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: {
        ...issueCommentCreatedPayload,
        comment: {
          ...issueCommentCreatedPayload.comment,
          html_url: 'https://github.com/evil/Hello-World/issues/7#issuecomment-123456789',
        },
      },
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(wrongRepo.url).toBe(
      'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
    );
    expect(wrongRepo.payload['commentHtmlUrl']).toBe(
      'https://github.com/evil/Hello-World/issues/7#issuecomment-123456789',
    );

    // Wrong parent number — fall back.
    const wrongNumber = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: {
        ...issueCommentCreatedPayload,
        comment: {
          ...issueCommentCreatedPayload.comment,
          html_url: 'https://github.com/octocat/Hello-World/issues/99#issuecomment-123456789',
        },
      },
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(wrongNumber.url).toBe(
      'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
    );

    // Wrong anchor (different comment id) — fall back.
    const wrongAnchor = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: {
        ...issueCommentCreatedPayload,
        comment: {
          ...issueCommentCreatedPayload.comment,
          html_url: 'https://github.com/octocat/Hello-World/issues/7#issuecomment-999',
        },
      },
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(wrongAnchor.url).toBe(
      'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
    );

    // Wrong parent kind (issues vs pull) — fall back.
    const wrongKind = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: {
        ...issueCommentOnPrPayload,
        comment: {
          ...issueCommentOnPrPayload.comment,
          html_url: 'https://github.com/octocat/Hello-World/issues/42#issuecomment-555',
        },
      },
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(wrongKind.payload['parentType']).toBe('pull_request');
    expect(wrongKind.url).toBe(
      'https://github.com/octocat/Hello-World/pull/42#issuecomment-555',
    );
  });
});

// ── Failure / ignore paths ───────────────────────────────────────────────────

describe('normalizeCommentEvent — failure / ignore paths (never fabricate)', () => {
  it('unhandled event → null (not coerced into github_pr_comment)', () => {
    expect(
      normalizeCommentEvent({
        githubEvent: 'push',
        payload: issueCommentCreatedPayload,
        deliveryId: DELIVERY,
        webhookVerified: true,
        serverTime: SERVER_TIME,
      }),
    ).toBeNull();
  });

  it('missing comment id → null (no stable identity anchor)', () => {
    const payload = {
      ...issueCommentCreatedPayload,
      comment: { ...issueCommentCreatedPayload.comment, id: undefined },
    };
    expect(
      normalizeCommentEvent({
        githubEvent: 'issue_comment',
        payload,
        deliveryId: DELIVERY,
        webhookVerified: true,
        serverTime: SERVER_TIME,
      }),
    ).toBeNull();
  });

  it('missing parent issue → null (a comment without its parent is not evidence)', () => {
    const payload = { ...issueCommentCreatedPayload, issue: undefined };
    expect(
      normalizeCommentEvent({
        githubEvent: 'issue_comment',
        payload,
        deliveryId: DELIVERY,
        webhookVerified: true,
        serverTime: SERVER_TIME,
      }),
    ).toBeNull();
  });

  it('missing repository identity → null (cannot build permalink/externalId)', () => {
    const payload = { ...issueCommentCreatedPayload, repository: undefined };
    expect(
      normalizeCommentEvent({
        githubEvent: 'issue_comment',
        payload,
        deliveryId: DELIVERY,
        webhookVerified: true,
        serverTime: SERVER_TIME,
      }),
    ).toBeNull();
  });

  it('missing action → null', () => {
    const payload = { ...issueCommentCreatedPayload, action: undefined };
    expect(
      normalizeCommentEvent({
        githubEvent: 'issue_comment',
        payload,
        deliveryId: DELIVERY,
        webhookVerified: true,
        serverTime: SERVER_TIME,
      }),
    ).toBeNull();
  });

  it('pull_request_review with no review object → null', () => {
    const payload = { ...reviewSubmittedPayload, review: undefined };
    expect(
      normalizeCommentEvent({
        githubEvent: 'pull_request_review',
        payload,
        deliveryId: DELIVERY,
        webhookVerified: true,
        serverTime: SERVER_TIME,
      }),
    ).toBeNull();
  });
});

// ── Boundary / security counterexamples ──────────────────────────────────────

describe('normalizeCommentEvent — boundary / security counterexamples', () => {
  it('never fabricates an actor: missing sender → null even when webhookVerified', () => {
    const payload = { ...issueCommentCreatedPayload, sender: undefined };
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    });
    expect(ev).not.toBeNull();
    expect(ev!.actor).toBeNull();
    // A verified delivery without a sender still records provenance as
    // webhook_verified for the delivery channel — but the actor claim itself
    // is null/unknown, never invented (N2).
    expect(ev!.actorProvenance).toBe('webhook_verified');
  });

  it('unverified webhook → actorProvenance "unknown" (never webhook_verified)', () => {
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: issueCommentCreatedPayload,
      deliveryId: DELIVERY,
      webhookVerified: false,
      serverTime: SERVER_TIME,
    })!;
    expect(ev.actorProvenance).toBe('unknown');
  });

  it('malformed html_url is NOT trusted as the permalink (no attacker URL, falls back to construction)', () => {
    const payload = {
      ...issueCommentCreatedPayload,
      comment: {
        ...issueCommentCreatedPayload.comment,
        html_url: 'https://evil.example.com/pull/42#issuecomment-1',
      },
    };
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    // Rejected — regardless of signature verification, a non-github.com
    // html_url never becomes the stored immutable-evidence link.
    expect(ev.url).toBe(
      'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
    );
    // The raw (malformed) fact is still preserved verbatim per §5.4.
    expect(ev.payload['commentHtmlUrl']).toBe('https://evil.example.com/pull/42#issuecomment-1');
  });

  it('non-URL html_url falls back to construction', () => {
    const payload = {
      ...issueCommentCreatedPayload,
      comment: { ...issueCommentCreatedPayload.comment, html_url: 'not a url' },
    };
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(ev.url).toBe(
      'https://github.com/octocat/Hello-World/issues/7#issuecomment-123456789',
    );
    expect(ev.payload['commentHtmlUrl']).toBe('not a url');
  });

  it('resolveCommentPermalink: prefers a genuine github.com html_url', () => {
    expect(
      resolveCommentPermalink(
        'https://github.com/octocat/Hello-World/issues/7#issuecomment-1',
        'octocat/Hello-World',
        'issue',
        7,
        'issue_comment',
        1,
      ),
    ).toBe('https://github.com/octocat/Hello-World/issues/7#issuecomment-1');
  });

  it('missing provider timestamp → occurred_at uses server time with "server" provenance (N8)', () => {
    const payload = {
      action: 'created',
      issue: issueCommentCreatedPayload.issue,
      comment: {
        id: 1,
        body: 'no timestamp here',
      },
      repository: issueCommentCreatedPayload.repository,
      sender: { login: 'octocat', id: 583231, type: 'User' },
    };
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(ev.occurredAt).toBe(SERVER_TIME);
    expect(ev.occurredAtProvenance).toBe('server');
  });

  it('body is passed through raw — redaction is the ingestion layer\'s job (§5.3 order)', () => {
    // Boundary fixture (intentionally not redacted) proving the connector does
    // NOT duplicate the strip step: receive(=connector) -> validate -> strip.
    // Stripping here would drop original evidence before the contract-ordered
    // redaction and would hide the preserved raw fact.
    const payload = {
      action: 'created',
      issue: issueCommentCreatedPayload.issue,
      comment: {
        id: 1,
        body: 'secret token is <private>x-api-key-abc</private> and more text',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        html_url:
          'https://github.com/octocat/Hello-World/issues/7#issuecomment-1',
      },
      repository: issueCommentCreatedPayload.repository,
      sender: { login: 'octocat', id: 583231, type: 'User' },
    };
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(ev.payload['body']).toBe(
      'secret token is <private>x-api-key-abc</private> and more text',
    );
  });

  it('null comment body (e.g. deleted/dismissed) preserved as null, not fabricated', () => {
    const payload = {
      action: 'deleted',
      issue: issueCommentCreatedPayload.issue,
      comment: {
        id: 1,
        body: null,
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T11:00:00Z',
      },
      repository: issueCommentCreatedPayload.repository,
      sender: { login: 'octocat', id: 583231, type: 'User' },
    };
    const ev = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(ev.payload['body']).toBeNull();
    expect(ev.sourceAction).toBe('deleted');
    expect(ev.occurredAt).toBe('2024-01-15T11:00:00.000Z'); // updated_at for non-created
  });

  it('installation id is preserved when present, absent when missing', () => {
    const withInstall = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: issueCommentCreatedPayload,
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(withInstall.payload['installationId']).toBe('424242');

    const withoutInstall = normalizeCommentEvent({
      githubEvent: 'issue_comment',
      payload: { ...issueCommentCreatedPayload, installation: undefined },
      deliveryId: DELIVERY,
      webhookVerified: true,
      serverTime: SERVER_TIME,
    })!;
    expect(withoutInstall.payload['installationId']).toBeUndefined();
  });
});