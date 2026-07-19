/**
 * GitHub `issues` webhook normalizer — unit tests (M0-GH-05, DUA-145).
 *
 * Covers the success, rejection, and security/boundary paths required by the
 * task's acceptance contract. No database and no mocks — the parser is a
 * pure function and the contract under test is its observable behaviour.
 *
 * CLI acceptance criterion from the task:
 *   "确认 issue 编号与 PR 编号的碰撞不会变成同一个来源事件" — captured by the
 *    `pr_in_issue_shape` rejection tests: a PR delivered in issues shape is
 *    refused by the issue parser, so its number never merges with a real
 *    issue event under the same delivery channel.
 */
import { describe, expect, it } from 'vitest';
import { normalizedEventSchema } from '../registry.js';
import {
  GITHUB_ISSUE_EVENT_KIND,
  GITHUB_ISSUES_EVENT,
  SUPPORTED_ISSUE_ACTIONS,
  normalizeGithubIssueEvent,
  rawGithubIssueWebhookSchema,
  type RawGithubIssueWebhook,
} from './issue.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// These are POST-VERIFICATION webhook bodies. They include `<private>` tags
// in *post-strip* tests separately; the success fixtures below carry no
// private content and represent real-world `issues` deliveries.

/**
 * A minimal-but-real GitHub "issues" webhook payload (opened action).
 * Mirrors GitHub's documented webhook contract: top-level `action`, nested
 * `issue`/`repository`/`sender`, ISO timestamps in GitHub's wire form
 * (no fractional seconds — Date handles it and the parser pads to ms).
 */
function openedIssuePayload(overrides?: Partial<RawGithubIssueWebhook>): RawGithubIssueWebhook {
  return {
    action: 'opened',
    issue: {
      id: 1_494_1932_564,
      number: 7,
      node_id: 'I_kwDOABcEdeABCDE',
      title: 'Investigate slow boot',
      body: '## Symptom\n\nThe app takes ~45s to start cold.\n\n## Repro\n\n- run `pnpm dev`\n- wait',
      state: 'open',
      labels: [
        { id: 1, name: 'bug' },
        { id: 2, name: 'performance' },
      ],
      html_url: 'https://github.com/octocat/Hello-World/issues/7',
      created_at: '2026-07-17T12:00:00Z',
      updated_at: '2026-07-17T12:00:00Z',
    },
    repository: {
      full_name: 'octocat/Hello-World',
      name: 'Hello-World',
      owner: { login: 'octocat' },
      html_url: 'https://github.com/octocat/Hello-World',
    },
    sender: { login: 'octocat', id: 583231, type: 'User' },
    installation: { id: 42 },
    ...overrides,
  } as RawGithubIssueWebhook;
}

function parse(input: unknown, deliveryId = 'del-aabbccddee') {
  return normalizeGithubIssueEvent({
    payload: input,
    deliveryId,
    webhookVerified: true,
  });
}

// ── Success paths ────────────────────────────────────────────────────────────

describe('normalizeGithubIssueEvent — success', () => {
  it('opened: emits a github_issue NormalizedEvent with stable identity + provider time', () => {
    const result = parse(openedIssuePayload());

    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : null;
    expect(event).not.toBeNull();
    expect(event!.connectorKind).toBe('github');
    expect(event!.eventKind).toBe(GITHUB_ISSUE_EVENT_KIND);
    expect(event!.sourceEvent).toBe(GITHUB_ISSUES_EVENT);
    expect(event!.sourceAction).toBe('opened');
    expect(event!.deliveryId).toBe('del-aabbccddee');
    expect(event!.itemKey).toBe('7'); // REST `number` is the cited key
    expect(event!.externalId).toBe('octocat/Hello-World#7');
    expect(event!.url).toBe('https://github.com/octocat/Hello-World/issues/7');

    // N8: provider timestamp parsed + normalized to ms-precision UTC.
    expect(event!.occurredAt).toBe('2026-07-17T12:00:00.000Z');
    expect(event!.occurredAtProvenance).toBe('provider');

    // N2: signature-verified webhook → webhook_verified provenance.
    expect(event!.actorProvenance).toBe('webhook_verified');
    expect(event!.actor).toMatchObject({
      kind: 'human',
      provider: 'github',
      providerUserId: '583231',
      displayLogin: 'octocat',
    });
  });

  it('opened: payload carries title, body, label names, nodeId and timestamps', () => {
    const result = parse(openedIssuePayload());

    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect(event!.payload).toMatchObject({
      action: 'opened',
      issue: {
        id: 1_494_193_256_4, // canonicalized
        number: 7,
        nodeId: 'I_kwDOABcEdeABCDE',
        title: 'Investigate slow boot',
        body: expect.stringContaining('## Symptom'),
        state: 'open',
        labels: [
          { id: 1, name: 'bug' },
          { id: 2, name: 'performance' },
        ],
        htmlUrl: 'https://github.com/octocat/Hello-World/issues/7',
        createdAt: '2026-07-17T12:00:00Z',
        updatedAt: '2026-07-17T12:00:00Z',
        closedAt: null,
      },
      repository: {
        fullName: 'octocat/Hello-World',
        url: 'https://github.com/octocat/Hello-World',
      },
      installation: { id: '42' },
    });
  });

  it('closed: action + state preserved with closed_at timestamp', () => {
    const result = parse(
      openedIssuePayload({
        action: 'closed',
        issue: {
          ...openedIssuePayload().issue,
          state: 'closed',
          closed_at: '2026-07-18T08:30:00Z',
          updated_at: '2026-07-18T08:30:00Z',
        },
      }),
    );

    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect(event!.sourceAction).toBe('closed');
    expect(event!.payload).toMatchObject({
      action: 'closed',
      issue: { state: 'closed', closedAt: '2026-07-18T08:30:00Z' },
    });
    expect(event!.occurredAt).toBe('2026-07-18T08:30:00.000Z');
  });

  const actionsThatShouldSucceed = [
    'reopened',
    'edited',
    'transferred',
    'labeled',
    'unlabeled',
    'assigned',
    'unassigned',
    'deleted',
  ] as const;

  it.each(actionsThatShouldSucceed)('action %s is supported and emits an event', (action) => {
    const result = parse(openedIssuePayload({ action }));
    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect(event!.sourceAction).toBe(action);
    expect(event!.payload).toMatchObject({ action });
  });

  it('repository.owner.login + repository.name reconstruct externalId when full_name is absent', () => {
    const result = parse(
      openedIssuePayload({
        repository: { name: 'Hello-World', owner: { login: 'octocat' } },
      }),
    );
    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect(event!.externalId).toBe('octocat/Hello-World#7');
    expect(event!.url).toBe('https://github.com/octocat/Hello-World/issues/7');
  });

  it('malformed issue.html_url falls back to a constructed canonical URL (never fabricated silently)', () => {
    const result = parse(openedIssuePayload({ issue: { ...openedIssuePayload().issue, html_url: 'not a url' } }));
    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect(event!.url).toBe('https://github.com/octocat/Hello-World/issues/7');
  });

  it('missing sender → actor is null, never fabricated (N2)', () => {
    const result = parse(openedIssuePayload({ sender: undefined }));
    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect(event!.actor).toBeNull();
    // actorProvenance is still webhook_verified (the actor CLAIM is absent,
    // not the sender-verification fact).
    expect(event!.actorProvenance).toBe('webhook_verified');
  });

  it('webhookVerified=false → actorProvenance=unknown (never client_claimed for a built-in connector)', () => {
    const result = normalizeGithubIssueEvent({
      payload: openedIssuePayload(),
      deliveryId: 'del-abc',
      webhookVerified: false,
    });
    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect(event!.actorProvenance).toBe('unknown');
  });

  it('emitted event passes the registry NormalizedEvent schema (cross-boundary validity)', () => {
    const result = parse(openedIssuePayload());
    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect(() => normalizedEventSchema.parse(event!)).not.toThrow();
  });

  it('SUPPORTED_ISSUE_ACTIONS is a frozen-shaped, intentional set (no noise actions)', () => {
    expect(SUPPORTED_ISSUE_ACTIONS).toContain('opened');
    expect(SUPPORTED_ISSUE_ACTIONS).toContain('closed');
    expect(SUPPORTED_ISSUE_ACTIONS).not.toContain('milestoned');
    expect(SUPPORTED_ISSUE_ACTIONS).not.toContain('locked');
    expect(SUPPORTED_ISSUE_ACTIONS).not.toContain('pinned');
  });
});

// ── Failure paths ────────────────────────────────────────────────────────────

describe('normalizeGithubIssueEvent — rejection', () => {
  it('pr_in_issue_shape: an issues delivery whose issue is a PR is rejected from the issue stream', () => {
    const payload = openedIssuePayload({
      issue: {
        ...openedIssuePayload().issue,
        pull_request: {
          url: 'https://api.github.com/repos/octocat/Hello-World/pulls/7',
          html_url: 'https://github.com/octocat/Hello-World/pull/7',
          diff_url: 'https://github.com/octocat/Hello-World/pull/7.diff',
          patch_url: 'https://github.com/octocat/Hello-World/pull/7.patch',
        },
      },
    });

    const result = parse(payload);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pr_in_issue_shape');
    expect(result.message).toMatch(/pull_request/i);
  });

  it('pr_in_issue_shape: an explicit null pull_request field is ACCEPTED (issue absent != present)', () => {
    // GitHub has historically sent `"pull_request": null` for issues — we must
    // not classify that as a PR. Only a non-null pointer is a reject signal.
    const payload = openedIssuePayload({
      issue: { ...openedIssuePayload().issue, pull_request: null },
    });
    const result = parse(payload);
    expect(result.ok).toBe(true);
  });

  it('unsupported_action: milestoned is rejected as a typed skip', () => {
    const result = parse(openedIssuePayload({ action: 'milestoned' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_action');
    expect(result.message).toContain('milestoned');
  });

  it('unsupported_action: locked is rejected as a typed skip', () => {
    const result = parse(openedIssuePayload({ action: 'locked' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_action');
  });

  it('invalid_payload: missing issue object → reject', () => {
    const result = parse({ action: 'opened', repository: openedIssuePayload().repository });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_payload');
  });

  it('invalid_payload: missing repository owner/name + full_name → reject', () => {
    const result = parse(openedIssuePayload({ repository: { name: 'Hello-World' } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_payload');
  });

  it('invalid_payload: unparseable timestamps → reject (never fabricate provider time)', () => {
    const result = parse(
      openedIssuePayload({
        issue: {
          ...openedIssuePayload().issue,
          updated_at: 'not a date',
          created_at: 'also not a date',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_payload');
  });

  it('caller-contract violation: empty deliveryId throws (not a silent reject)', () => {
    expect(() =>
      normalizeGithubIssueEvent({
        payload: openedIssuePayload(),
        deliveryId: '',
        webhookVerified: true,
      }),
    ).toThrow(/deliveryId/);
    expect(() =>
      normalizeGithubIssueEvent({
        payload: openedIssuePayload(),
        deliveryId: '   ',
        webhookVerified: true,
      }),
    ).toThrow(/deliveryId/);
  });
});

// ── Security/boundary: redaction before persistence (AGENTS.md §5.3) ─────────

describe('normalizeGithubIssueEvent — redaction (§5.3)', () => {
  it('strips <private>…</private> from issue body, title, and label names before constructing the event', () => {
    const payload = openedIssuePayload({
      issue: {
        ...openedIssuePayload().issue,
        title: 'Investigate <private>secret access path S3://bucket-x</private> boot',
        body: '## Context\n\nNeed auth at <private>hunter2</private> endpoint <private>internal-ip 10.0.0.9</private>\n\nEnd',
        labels: [
          { id: 1, name: 'bug' },
          { id: 2, name: '<private>internal-tag</private>-perf' },
        ],
      },
    });

    const result = parse(payload);
    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    const issue = (event!.payload as { issue: Record<string, unknown> }).issue;

    // title: `<private>...</private>` removed
    expect(issue['title']).toBe('Investigate  boot');

    // body: both inline sections removed
    expect(issue['body']).toBe('## Context\n\nNeed auth at  endpoint \n\nEnd');
    expect(issue['body']).not.toContain('hunter2');
    expect(issue['body']).not.toContain('10.0.0.9');

    // label name with a private substring
    expect(issue['labels']).toEqual([
      { id: 1, name: 'bug' },
      { id: 2, name: '-perf' },
    ]);

    // And the original unsafe strings do not survive anywhere in the payload.
    const serialized = JSON.stringify(event!.payload);
    expect(serialized).not.toContain('secret access path');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('internal-ip');
    expect(serialized).not.toContain('internal-tag');
  });

  it('an unclosed <private> tag over-redacts to end of string (no leak)', () => {
    const payload = openedIssuePayload({
      issue: {
        ...openedIssuePayload().issue,
        body: 'safe <private>col1 still here and never closed',
      },
    });
    const result = parse(payload);
    expect(result.ok).toBe(true);
    const event = result.ok ? result.event : undefined;
    expect((event!.payload as { issue: { body: string } }).issue.body).toBe('safe ');
  });
});

// ── CLI acceptance: issue vs PR number collision must not become ONE source event ──

describe('CLI acceptance — issue number vs PR number never merge into one source event', () => {
  it('issue #7 delivery-A emits an issue event (itemKey=7, kind=github_issue)', () => {
    const ret = parse(openedIssuePayload(), 'del-AAA-issue');
    expect(ret.ok).toBe(true);
    const event = ret.ok ? ret.event : undefined;
    expect(event!.eventKind).toBe('github_issue');
    expect(event!.itemKey).toBe('7');
    expect(event!.deliveryId).toBe('del-AAA-issue');
    expect(event!.externalId).toBe('octocat/Hello-World#7');
  });

  it('a PR #7 (same number, same repo) delivered in issues shape is REJECTED — NEVER becomes a github_issue', () => {
    const prAsIssuePayload = openedIssuePayload({
      issue: {
        ...openedIssuePayload().issue,
        pull_request: {
          url: 'https://api.github.com/repos/octocat/Hello-World/pulls/7',
          html_url: 'https://github.com/octocat/Hello-World/pull/7',
        },
      },
    });
    const ret = parse(prAsIssuePayload, 'del-BBB-pr-as-issue');
    expect(ret.ok).toBe(false);
    if (ret.ok) return;
    expect(ret.reason).toBe('pr_in_issue_shape');
  });

  it('two distinct issue deliveries sharing externalId stay separable by deliveryId (N1 identity = (project, channel, connectorKind, deliveryId, itemKey))', () => {
    const a = parse(openedIssuePayload({ action: 'opened' }), 'del-AAA').ok
      ? (parse(openedIssuePayload({ action: 'opened' }), 'del-AAA') as { ok: true; event: { deliveryId: string; itemKey: string; externalId: string } }).event
      : null;
    const b = parse(openedIssuePayload({ action: 'edited' }), 'del-BBB').ok
      ? (parse(openedIssuePayload({ action: 'edited' }), 'del-BBB') as { ok: true; event: { deliveryId: string; itemKey: string; externalId: string } }).event
      : null;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Same externalId + itemKey (same issue #7), but distinct deliveryIds —
    // the storage layer's idempotency identity (channel+deliveryId+itemKey)
    // will keep these as DISTINCT source events.
    expect(a!.externalId).toBe(b!.externalId);
    expect(a!.itemKey).toBe(b!.itemKey);
    expect(a!.deliveryId).not.toBe(b!.deliveryId);
  });

  it('the rejected PR #7 delivery is NOT a duplicate of the issue #7 event even if the same delivery id arrived', () => {
    // Hand-simulate the worst case: GitHub delivers a PR-as-issue into the
    // `issues` channel using the SAME X-GitHub-Delivery header value that an
    // earlier issue #7 used. The idempotency key (channel+deliveryId+itemKey)
    // would otherwise reuse the same identity — but the issue parser refuses
    // the PR-shaped one at the boundary: nothing is ever persisted under
    // that identity for the PR shape, so the issue event stands alone.
    const issueEv = parse(openedIssuePayload(), 'del-X');
    expect(issueEv.ok).toBe(true);

    const prAsIssue = parse(
      openedIssuePayload({
        issue: {
          ...openedIssuePayload().issue,
          pull_request: { html_url: 'https://github.com/octocat/Hello-World/pull/7' },
        },
      }),
      'del-X',
    );
    expect(prAsIssue.ok).toBe(false);
    if (prAsIssue.ok) return;
    expect(prAsIssue.reason).toBe('pr_in_issue_shape');
  });
});

// ── Zod schema sanity ────────────────────────────────────────────────────────

describe('rawGithubIssueWebhookSchema', () => {
  it('parses a real-shaped payload (loose on extras, strict on consumed fields)', () => {
    const got = rawGithubIssueWebhookSchema.safeParse(openedIssuePayload());
    expect(got.success).toBe(true);
  });

  it('rejects a non-object payload', () => {
    const got = rawGithubIssueWebhookSchema.safeParse('not an object');
    expect(got.success).toBe(false);
  });

  it('rejects when consumed fields have the wrong shape (e.g. number is a string)', () => {
    const payload = openedIssuePayload();
    (payload as { issue: { number: unknown } }).issue.number = '7';
    const got = rawGithubIssueWebhookSchema.safeParse(payload);
    expect(got.success).toBe(false);
  });
});