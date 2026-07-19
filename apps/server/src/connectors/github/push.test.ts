/**
 * GitHub `push` webhook normalizer — unit tests (DUA-143, M0-GH-03).
 *
 * Covers the three required CLI acceptance paths:
 *   1. run the push parser tests;
 *   2. parse a multi-commit fixture → each commit yields an independent,
 *      stable item key (commit SHA) while sharing the delivery id;
 *   3. parse the same fixture twice → identical normalized identity.
 *
 * Plus the success/failure/security boundary paths required by the task:
 *   - new-branch push is still processed (created + zero `before`);
 *   - single-commit push;
 *   - `<private>` content in commit message is stripped from the emitted
 *     payload before it leaves the producer (AGENTS.md §5.3);
 *   - deleted ref, all-zeros `after`, non-branch ref, missing repo, empty
 *     commits, and malformed commits are ignored (noise → `[]` or dropped);
 *   - actor is preserved as-is (null when absent — never fabricated, N2).
 *
 * All fixtures are sanitized synthetic data (脱敏 fixture) — no real
 * secrets, tokens, or personal data. Pure-function tests; no database.
 */
import { describe, expect, it } from 'vitest';
import { normalizePushEvent } from './push.js';
import { normalizedEventSchema } from '../registry.js';
import type { NormalizedEvent } from '../registry.js';

const DELIVERY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ── Sanitized fixtures ───────────────────────────────────────────────────────

/**
 * A two-commit push to `refs/heads/main` in `teamem/demo`.  All names,
 * logins, SHAs and timestamps are synthetic placeholder data.
 *
 * Returns a loosely-typed record so individual test cases can freely mutate
 * `ref`, `after`, `commits`, delete fields, etc. without TS narrowing the
 * inferred literal shape in front of us.
 */
function twoCommitPushPayload(): Record<string, unknown> {
  return {
    ref: 'refs/heads/main',
    before: '0'.repeat(40),
    after: '2222222222222222222222222222222222222222',
    created: true,
    deleted: false,
    forced: false,
    repository: {
      full_name: 'teamem/demo',
      name: 'demo',
      owner: { login: 'teamem' },
    },
    sender: { login: 'octocat', id: 583231, type: 'User' },
    pusher: { name: 'octocat', email: 'octocat@example.invalid' },
    head_commit: {
      id: '2222222222222222222222222222222222222222',
      timestamp: '2024-01-15T20:30:00Z',
      message: 'second synthetic commit',
      url: 'https://github.com/teamem/demo/commit/2222222222222222222222222222222222222222',
      author: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
      committer: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
    },
    commits: [
      {
        id: '1111111111111111111111111111111111111111',
        timestamp: '2024-01-15T20:20:00Z',
        message: 'first synthetic commit',
        url: 'https://github.com/teamem/demo/commit/1111111111111111111111111111111111111111',
        author: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
        committer: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
        distinct: true,
      },
      {
        id: '2222222222222222222222222222222222222222',
        timestamp: '2024-01-15T20:30:00Z',
        message: 'second synthetic commit',
        url: 'https://github.com/teamem/demo/commit/2222222222222222222222222222222222222222',
        author: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
        committer: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
        distinct: true,
      },
    ],
  };
}

// ── 1. push parser tests run ─────────────────────────────────────────────────

describe('normalizePushEvent — runs and parses', () => {
  it('parses a single-commit push into one event', () => {
    const base = twoCommitPushPayload();
    const firstCommit = (base['commits'] as unknown[])[0];
    const payload: Record<string, unknown> = {
      ...base,
      commits: [firstCommit],
      after: '1111111111111111111111111111111111111111',
    };
    const events = normalizePushEvent({ deliveryId: DELIVERY_ID, payload });
    expect(events).toHaveLength(1);
    expect(events[0]!.itemKey).toBe('1111111111111111111111111111111111111111');
  });
});

// ── 2. multi-commit fixture → independent stable item_keys, shared delivery id ──

describe('multi-commit push (CLI acceptance #2)', () => {
  it('one event per commit, each commit SHA as itemKey, delivery id shared', () => {
    const events = normalizePushEvent({
      deliveryId: DELIVERY_ID,
      payload: twoCommitPushPayload(),
    });

    expect(events).toHaveLength(2);

    // delivery id is shared across the whole delivery (N1)
    expect(new Set(events.map((e) => e.deliveryId))).toEqual(new Set([DELIVERY_ID]));

    // itemKeys are the two distinct commit SHAs (stable sub-item ids)
    const itemKeys = events.map((e) => e.itemKey).sort();
    expect(itemKeys).toEqual([
      '1111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222',
    ]);

    // commits are emitted in the order GitHub lists them (no reordering)
    expect(events.map((e) => e.itemKey)).toEqual([
      '1111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222',
    ]);
  });

  it('eventKind is the closed github_commit SourceKind, sourceEvent is "push" (Q6)', () => {
    const [event] = normalizePushEvent({
      deliveryId: DELIVERY_ID,
      payload: twoCommitPushPayload(),
    });
    expect(event!.connectorKind).toBe('github');
    expect(event!.eventKind).toBe('github_commit');
    expect(event!.sourceEvent).toBe('push');
  });

  it('immutable commit URL is canonical and constructed from owner/repo/sha', () => {
    const events = normalizePushEvent({
      deliveryId: DELIVERY_ID,
      payload: twoCommitPushPayload(),
    });
    expect(events[0]!.url).toBe(
      'https://github.com/teamem/demo/commit/1111111111111111111111111111111111111111',
    );
    expect(events[1]!.url).toBe(
      'https://github.com/teamem/demo/commit/2222222222222222222222222222222222222222',
    );
  });

  it('externalId is the human-meaningful repo@sha ref', () => {
    const [event] = normalizePushEvent({
      deliveryId: DELIVERY_ID,
      payload: twoCommitPushPayload(),
    });
    expect(event!.externalId).toBe(
      'teamem/demo@1111111111111111111111111111111111111111',
    );
  });

  it('actor is preserved verbatim from the verified sender (N2)', () => {
    const [event] = normalizePushEvent({
      deliveryId: DELIVERY_ID,
      payload: twoCommitPushPayload(),
    });
    expect(event!.actor).toEqual({
      kind: 'human',
      provider: 'github',
      providerUserId: '583231',
      displayLogin: 'octocat',
    });
    expect(event!.actorProvenance).toBe('webhook_verified');
  });

  it('occurredAt is the commit timestamp normalized to UTC ms precision (N8)', () => {
    const events = normalizePushEvent({
      deliveryId: DELIVERY_ID,
      payload: twoCommitPushPayload(),
    });
    expect(events[0]!.occurredAt).toBe('2024-01-15T20:20:00.000Z');
    expect(events[1]!.occurredAt).toBe('2024-01-15T20:30:00.000Z');
    expect(events[0]!.occurredAtProvenance).toBe('provider');
  });

  it('every emitted event passes the runtime normalizedEventSchema (cross-boundary Zod)', () => {
    const events = normalizePushEvent({
      deliveryId: DELIVERY_ID,
      payload: twoCommitPushPayload(),
    });
    for (const e of events) {
      const result = normalizedEventSchema.safeParse(e);
      expect(result.success).toBe(true);
    }
  });
});

// ── 3. determinism — same fixture twice → identical normalized identity ───────

describe('determinism (CLI acceptance #3)', () => {
  const identityRelevant = (e: NormalizedEvent) => ({
    connectorKind: e.connectorKind,
    eventKind: e.eventKind,
    sourceEvent: e.sourceEvent,
    deliveryId: e.deliveryId,
    itemKey: e.itemKey,
    externalId: e.externalId,
    url: e.url,
    actor: e.actor,
    actorProvenance: e.actorProvenance,
    occurredAt: e.occurredAt,
    occurredAtProvenance: e.occurredAtProvenance,
    // payload is part of the N1 payload hash, so it must also be identical
    payload: e.payload,
  });

  it('parsing the same fixture twice yields identical identity + payload', () => {
    const a = normalizePushEvent({ deliveryId: DELIVERY_ID, payload: twoCommitPushPayload() });
    const b = normalizePushEvent({ deliveryId: DELIVERY_ID, payload: twoCommitPushPayload() });
    expect(a.map(identityRelevant)).toEqual(b.map(identityRelevant));
  });

  it('a delivery replayed with the same deliveryId produces the same itemKeys', () => {
    const a = normalizePushEvent({ deliveryId: DELIVERY_ID, payload: twoCommitPushPayload() });
    const b = normalizePushEvent({ deliveryId: DELIVERY_ID, payload: twoCommitPushPayload() });
    expect(a.map((e) => `${e.deliveryId}/${e.itemKey}`)).toEqual(
      b.map((e) => `${e.deliveryId}/${e.itemKey}`),
    );
  });
});

// ── success path: new-branch push is still processed ─────────────────────────

describe('new-branch push (created ref, before all zeros)', () => {
  it('processes the commits normally — creation is NOT noise', () => {
    const payload = twoCommitPushPayload(); // created:true, before all-zeros
    const events = normalizePushEvent({ deliveryId: DELIVERY_ID, payload });
    expect(events).toHaveLength(2);
    expect(payload.created).toBe(true);
    expect(payload.before).toBe('0'.repeat(40));
  });
});

// ── redaction boundary (security, AGENTS.md §5.3) ────────────────────────────

describe('redaction — <private> stripped from emitted payload before leaving producer', () => {
  it('commit message with <private> section is stripped', () => {
    const payload = twoCommitPushPayload();
    payload.commits = [
      {
        id: '3333333333333333333333333333333333333333',
        timestamp: '2024-01-15T21:00:00Z',
        message: 'public part <private>INTERNAL_TOKEN=secret</private> trailing',
        url: 'https://github.com/teamem/demo/commit/3333333333333333333333333333333333333333',
        author: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
        committer: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
      },
    ];
    payload.after = '3333333333333333333333333333333333333333';

    const [event] = normalizePushEvent({ deliveryId: DELIVERY_ID, payload });

    expect(event!.payload['message']).toBe('public part  trailing');
    // we never leak the secret into the payload that the producer emits
    expect(JSON.stringify(event!.payload)).not.toContain('INTERNAL_TOKEN');
    expect(JSON.stringify(event!.payload)).not.toContain('secret');
  });

  it('author email inside <private> tags is redacted', () => {
    const payload = twoCommitPushPayload();
    payload.commits = [
      {
        id: '4444444444444444444444444444444444444444',
        timestamp: '2024-01-15T21:30:00Z',
        message: 'clean commit',
        author: {
          name: 'Octo Cat',
          email: '<private>do-not-leak@example.invalid</private>',
          username: 'octocat',
        },
        committer: { name: 'Octo Cat', email: 'octocat@example.invalid', username: 'octocat' },
      },
    ];
    payload.after = '4444444444444444444444444444444444444444';

    const [event] = normalizePushEvent({ deliveryId: DELIVERY_ID, payload });
    const author = event!.payload['author'] as { email?: string };
    expect(author.email).toBe('');
    expect(JSON.stringify(event!.payload)).not.toContain('do-not-leak');
  });
});

// ── noise / boundary — unsupported and deleted refs are ignored ─────────────

describe('noise: deleted ref (deleted:true)', () => {
  it('returns [] when deleted:true, even if commits are present', () => {
    const payload = { ...twoCommitPushPayload(), deleted: true };
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });
});

describe('noise: all-zeros after (ref deletion)', () => {
  it('returns [] when after is all-zeros, even without deleted flag', () => {
    const payload = { ...twoCommitPushPayload(), deleted: false, after: '0'.repeat(40) };
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });
});

describe('noise: non-branch ref (tag / unknown namespace)', () => {
  it('returns [] for a tag push (refs/tags/*)', () => {
    const payload = { ...twoCommitPushPayload(), ref: 'refs/tags/v1.0.0' };
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });

  it('returns [] for a ref outside the heads namespace entirely', () => {
    const payload = { ...twoCommitPushPayload(), ref: 'refs/pull/42/merge' };
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });

  it('returns [] when ref is missing', () => {
    const payload = twoCommitPushPayload();
    delete payload.ref;
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });
});

describe('noise: missing or malformed repository', () => {
  it('returns [] when repository is absent', () => {
    const payload = twoCommitPushPayload();
    delete payload.repository;
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });

  it('returns [] when full_name cannot be derived', () => {
    const payload = twoCommitPushPayload();
    payload.repository = { name: 'demo' }; // no owner/full_name
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });
});

describe('noise: empty commits array', () => {
  it('returns [] when commits is empty (no fabrication of a head event)', () => {
    const payload = { ...twoCommitPushPayload(), commits: [] };
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });

  it('returns [] when commits is absent', () => {
    const payload = twoCommitPushPayload();
    delete payload.commits;
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });
});

describe('noise: malformed individual commits are dropped, valid ones emitted', () => {
  it('a commit with a zero SHA is dropped, the other commit is emitted', () => {
    const payload = twoCommitPushPayload();
    payload.commits = [
      {
        id: '0'.repeat(40),
        timestamp: '2024-01-15T21:00:00Z',
        message: 'zero sha (deletion ref artifact)',
      },
      {
        id: '5555555555555555555555555555555555555555',
        timestamp: '2024-01-15T21:01:00Z',
        message: 'valid synthetic commit',
      },
    ];
    payload.after = '5555555555555555555555555555555555555555';
    const events = normalizePushEvent({ deliveryId: DELIVERY_ID, payload });
    expect(events).toHaveLength(1);
    expect(events[0]!.itemKey).toBe('5555555555555555555555555555555555555555');
  });

  it('a commit with an unparseable timestamp is dropped', () => {
    const payload = twoCommitPushPayload();
    payload.commits = [
      {
        id: '6666666666666666666666666666666666666666',
        timestamp: 'not-a-date',
        message: 'bad timestamp',
      },
      {
        id: '7777777777777777777777777777777777777777',
        timestamp: '2024-01-15T22:00:00Z',
        message: 'valid synthetic commit',
      },
    ];
    payload.after = '7777777777777777777777777777777777777777';
    const events = normalizePushEvent({ deliveryId: DELIVERY_ID, payload });
    expect(events).toHaveLength(1);
    expect(events[0]!.itemKey).toBe('7777777777777777777777777777777777777777');
  });

  it('returns [] when every commit is malformed', () => {
    const payload = twoCommitPushPayload();
    payload.commits = [
      { id: '0'.repeat(40), timestamp: '2024-01-15T22:00:00Z', message: 'zero' },
      { id: '8888888888888888888888888888888888888888', timestamp: 'bad', message: 'bad ts' },
    ];
    expect(normalizePushEvent({ deliveryId: DELIVERY_ID, payload })).toEqual([]);
  });
});

// ── failure / boundary: actor preservation (N2 — never fabricated) ───────────

describe('actor preservation (N2)', () => {
  it('missing sender → actor null, actorProvenance webhook_verified', () => {
    const payload = twoCommitPushPayload();
    delete payload.sender;
    const [event] = normalizePushEvent({ deliveryId: DELIVERY_ID, payload });
    expect(event!.actor).toBeNull();
    // provenance tracks the channel, not the actor's presence
    expect(event!.actorProvenance).toBe('webhook_verified');
  });

  it('a bot sender → kind service, identity preserved', () => {
    const payload = twoCommitPushPayload();
    payload.sender = { login: 'dependabot[bot]', id: 49699333, type: 'Bot' };
    const [event] = normalizePushEvent({ deliveryId: DELIVERY_ID, payload });
    expect(event!.actor).toEqual({
      kind: 'service',
      provider: 'github',
      providerUserId: '49699333',
      displayLogin: 'dependabot[bot]',
    });
  });

  it('unverified payload (webhookVerified:false) → actorProvenance unknown', () => {
    const [event] = normalizePushEvent({
      deliveryId: DELIVERY_ID,
      payload: twoCommitPushPayload(),
      webhookVerified: false,
    });
    expect(event!.actorProvenance).toBe('unknown');
  });
});

// ── boundary: missing delivery id ────────────────────────────────────────────

describe('missing delivery id', () => {
  it('returns [] — no fabricated idempotency identity (N1)', () => {
    expect(normalizePushEvent({ deliveryId: '', payload: twoCommitPushPayload() })).toEqual([]);
  });
});