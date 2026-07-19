/**
 * Pull Request webhook normalization tests (DUA-144 / M0-GH-04).
 *
 * Covers the DUA-144 CLI acceptance set explicitly:
 *   1. opened, synchronize, closed-unmerged, merged — normalize to real
 *      NormalizedEvents with the right source/event/action/state/merge facts.
 *   2. action is a SOURCE FACT only — it never participates in idempotency
 *      identity, so the same delivery+PR-key rolls up to one identity
 *      regardless of action (CLI acceptance #2).
 *
 * Plus the success / failure / boundary & security counterexamples required
 * by the engineering red lines: unsupported action ignored, missing sender
 * preserved as null (not fabricated), missing repo throws, missing provider
 * time falls back to server time with the correct provenance, `<private>`
 * content in the body is preserved verbatim by the parser (redaction happens
 * exactly once, in the frozen pipeline order), and the returned event parses
 * against the connector producer contract `normalizedEventSchema`.
 *
 * No database dependency — these are pure-function unit tests over redacted
 * synthetic fixtures (see `pull-request.fixtures.ts`).
 */
import { describe, expect, it } from 'vitest';
import { normalizedEventSchema } from '../registry.js';
import { stripPrivateTags } from '../../security/private-tags.js';
import {
  asPullRequestFacts,
  normalizePullRequestEvent,
  normalizeGithubTimestamp,
  isSupportedPrAction,
  type PullRequestNormalizationContext,
} from './pull-request.js';
import {
  CLOSED_UNMERGED_FIXTURE,
  EDITED_FIXTURE,
  LABELED_FIXTURE,
  MERGED_FIXTURE,
  MISSING_ACTION_FIXTURE,
  OPENED_FIXTURE,
  OPENED_MISSING_SENDER_FIXTURE,
  OPENED_NO_TIMESTAMPS_FIXTURE,
  OPENED_WITH_NO_PR_FIXTURE,
  OPENED_WITH_NO_REPO_FIXTURE,
  OPENED_WITH_PRIVATE_BODY_FIXTURE,
  REOPENED_FIXTURE,
  REVIEW_REQUESTED_FIXTURE,
  SYNCHRONIZE_FIXTURE,
  SYNTHETIC_DELIVERY_ID,
  SYNTHETIC_PR_NUMBER,
  SYNTHETIC_REPO_FULL_NAME,
  SYNTHETIC_SERVER_RECEIVE_TIME,
} from './pull-request.fixtures.js';

const VERIFIED_CTX: PullRequestNormalizationContext = {
  deliveryId: SYNTHETIC_DELIVERY_ID,
  webhookVerified: true,
  serverReceiveTime: SYNTHETIC_SERVER_RECEIVE_TIME,
};

const UNVERIFIED_CTX: PullRequestNormalizationContext = {
  deliveryId: SYNTHETIC_DELIVERY_ID,
  webhookVerified: false,
  serverReceiveTime: SYNTHETIC_SERVER_RECEIVE_TIME,
};

const PR_URL = `https://github.com/${SYNTHETIC_REPO_FULL_NAME}/pull/${SYNTHETIC_PR_NUMBER}`;
const PR_EXTERNAL_ID = `${SYNTHETIC_REPO_FULL_NAME}#${SYNTHETIC_PR_NUMBER}`;
const PR_ITEM_KEY = String(SYNTHETIC_PR_NUMBER);

// ── Supported-action gate ─────────────────────────────────────────────────────

describe('isSupportedPrAction', () => {
  it.each(['opened', 'edited', 'synchronize', 'closed', 'reopened'])(
    'supports %s',
    (action) => {
      expect(isSupportedPrAction(action)).toBe(true);
    },
  );

  it.each([
    'labeled',
    'unlabeled',
    'assigned',
    'unassigned',
    'review_requested',
    'review_request_removed',
    'ready_for_review',
    'converted_to_draft',
    'auto_merge_enabled',
    'auto_merge_disabled',
  ])('explicitly ignores %s', (action) => {
    expect(isSupportedPrAction(action)).toBe(false);
  });

  it('treats missing action as not supported (empty string and undefined)', () => {
    expect(isSupportedPrAction(undefined)).toBe(false);
    expect(isSupportedPrAction('')).toBe(false);
  });
});

// ── normalizeGithubTimestamp — second→millisecond precision (N8) ──────────────

describe('normalizeGithubTimestamp', () => {
  it('second-precision UTC → millisecond-precision UTC Z', () => {
    expect(normalizeGithubTimestamp('2024-06-01T12:00:00Z')).toBe(
      '2024-06-01T12:00:00.000Z',
    );
  });

  it('already-millisecond UTC passes through unchanged', () => {
    expect(normalizeGithubTimestamp('2024-06-01T12:00:00.500Z')).toBe(
      '2024-06-01T12:00:00.500Z',
    );
  });

  it('non-UTC offset is converted to UTC Z', () => {
    expect(normalizeGithubTimestamp('2024-06-01T14:00:00+02:00')).toBe(
      '2024-06-01T12:00:00.000Z',
    );
  });

  it('null/undefined/empty → null (never fabricated)', () => {
    expect(normalizeGithubTimestamp(null)).toBeNull();
    expect(normalizeGithubTimestamp(undefined)).toBeNull();
    expect(normalizeGithubTimestamp('')).toBeNull();
    expect(normalizeGithubTimestamp('   ')).toBeNull();
  });

  it('unparseable string → null (no throw)', () => {
    expect(normalizeGithubTimestamp('not-a-date')).toBeNull();
  });
});

// ── DUA-144 CLI acceptance #1: the four mandated fixtures normalize ───────────

describe('DUA-144 CLI acceptance #1 — four PR fixtures normalize to real events', () => {
  it('opened: action=opened, state=open, merged=false, body preserved', () => {
    const ev = normalizePullRequestEvent(OPENED_FIXTURE, VERIFIED_CTX);
    expect(ev).not.toBeNull();
    const facts = asPullRequestFacts(ev!.payload)!;

    expect(ev!.connectorKind).toBe('github');
    expect(ev!.eventKind).toBe('github_pr');
    expect(ev!.sourceEvent).toBe('pull_request'); // original fact preserved
    expect(ev!.sourceAction).toBe('opened'); // original fact preserved
    expect(ev!.deliveryId).toBe(SYNTHETIC_DELIVERY_ID);
    expect(ev!.itemKey).toBe(PR_ITEM_KEY);
    expect(ev!.externalId).toBe(PR_EXTERNAL_ID); // stable "org/repo#num"
    expect(ev!.url).toBe(PR_URL);

    expect(facts.action).toBe('opened');
    expect(facts.number).toBe(SYNTHETIC_PR_NUMBER);
    expect(facts.title).toBe('Add Postgres-backed event store');
    expect(facts.body).toBe(
      'Closes #12. This introduces the events table and a pg-boss queue.',
    );
    expect(facts.state).toBe('open');
    expect(facts.merged).toBe(false);
    expect(facts.mergedAt).toBeNull();
    expect(facts.draft).toBe(false);
    expect(facts.base).toEqual({ ref: 'main', sha: 'a'.repeat(40) });
    expect(facts.head).toEqual({ ref: 'feat/event-store', sha: 'b'.repeat(40) });

    // provider time from updated_at (== created_at here), millisecond-precision.
    expect(ev!.occurredAt).toBe('2024-06-01T12:00:00.000Z');
    expect(ev!.occurredAtProvenance).toBe('provider');

    // actor = webhook sender (human), provenance webhook-verified.
    expect(ev!.actor).toEqual({
      kind: 'human',
      provider: 'github',
      providerUserId: '424242',
      displayLogin: 'synthauthor',
    });
    expect(ev!.actorProvenance).toBe('webhook_verified');
  });

  it('synchronize: action=synchronize, head SHA advances, updated_at time advances', () => {
    const ev = normalizePullRequestEvent(SYNCHRONIZE_FIXTURE, VERIFIED_CTX);
    const facts = asPullRequestFacts(ev!.payload)!;

    expect(ev!.sourceAction).toBe('synchronize');
    expect(facts.action).toBe('synchronize');
    expect(facts.head).toEqual({ ref: 'feat/event-store', sha: 'c'.repeat(40) });
    expect(facts.state).toBe('open');
    expect(facts.merged).toBe(false);
    expect(ev!.occurredAt).toBe('2024-06-01T12:20:00.000Z');
    expect(ev!.occurredAtProvenance).toBe('provider');
  });

  it('closed-unmerged: action=closed, merged=false, mergedAt=null', () => {
    const ev = normalizePullRequestEvent(CLOSED_UNMERGED_FIXTURE, VERIFIED_CTX);
    const facts = asPullRequestFacts(ev!.payload)!;

    expect(ev!.sourceAction).toBe('closed');
    expect(facts.action).toBe('closed');
    expect(facts.state).toBe('closed');
    expect(facts.merged).toBe(false); // the merge fact — not a second action
    expect(facts.mergedAt).toBeNull();
    expect(ev!.occurredAt).toBe('2024-06-02T08:00:00.000Z');
  });

  it('merged: action STILL "closed" (the merge fact is pull_request.merged=true + merged_at)', () => {
    const ev = normalizePullRequestEvent(MERGED_FIXTURE, VERIFIED_CTX);
    const facts = asPullRequestFacts(ev!.payload)!;

    // §5.4: action is the raw "closed" string; merged is a SEPARATE fact.
    expect(ev!.sourceAction).toBe('closed');
    expect(facts.action).toBe('closed');
    expect(facts.state).toBe('closed');
    expect(facts.merged).toBe(true); // merge fact preserved verbatim
    expect(facts.mergedAt).toBe('2024-06-02T08:05:00.000Z');
    expect(ev!.occurredAt).toBe('2024-06-02T08:05:00.000Z');
    expect(facts.head).toEqual({ ref: 'feat/event-store', sha: 'e'.repeat(40) });

    // Trigger actor = the merge bot (sender), separate from PR author.
    expect(ev!.actor).toEqual({
      kind: 'service',
      provider: 'github',
      providerUserId: '7777777',
      displayLogin: 'synth-bot[bot]',
    });
    // PR author preserved as a distinct fact in the payload.
    expect(facts.author).toEqual({ login: 'synthauthor', id: 424242, type: 'User' });
  });
});

// ── DUA-144 CLI acceptance #2: action is a SOURCE FACT, not identity ─────────

describe('DUA-144 CLI acceptance #2 — action does not change delivery identity (N1)', () => {
  it('opened + synchronize share delivery/item identity → same idempotency identity', () => {
    // Same deliveryId + same PR number = same itemKey. Action is in the
    // payload, NOT in the identity. The N1 identity (channel+deliveryId+
    // itemKey) is identical; only the payload hash (which encodes action)
    // distinguishes them, so the second is NOT deduped as a repeat of the
    // first — it is a real new event.
    const opened = normalizePullRequestEvent(OPENED_FIXTURE, VERIFIED_CTX)!;
    const sync = normalizePullRequestEvent(SYNCHRONIZE_FIXTURE, VERIFIED_CTX)!;

    expect(opened.deliveryId).toBe(sync.deliveryId);
    expect(opened.itemKey).toBe(sync.itemKey);
    expect(opened.connectorKind).toBe(sync.connectorKind);
    expect(opened.eventKind).toBe(sync.eventKind);
    expect(opened.externalId).toBe(sync.externalId);

    // But actions differ (and so does the payload hash) — action is recorded.
    expect(opened.sourceAction).toBe('opened');
    expect(sync.sourceAction).toBe('synchronize');
    expect(opened.payload).not.toBe(sync.payload);
  });

  it('closed-unmerged + merged share identity, differ ONLY in the merge fact', () => {
    const unmerged = normalizePullRequestEvent(CLOSED_UNMERGED_FIXTURE, VERIFIED_CTX)!;
    const merged = normalizePullRequestEvent(MERGED_FIXTURE, VERIFIED_CTX)!;

    // Identity is identical (same action gate result "closed", same PR).
    expect(unmerged.deliveryId).toBe(merged.deliveryId);
    expect(unmerged.itemKey).toBe(merged.itemKey);
    expect(unmerged.sourceAction).toBe('closed'); // both
    expect(merged.sourceAction).toBe('closed');

    // Merge fact is what differs — and it is NOT a second action.
    expect(asPullRequestFacts(unmerged.payload)!.merged).toBe(false);
    expect(asPullRequestFacts(merged.payload)!.merged).toBe(true);
  });
});

// ── Success paths: other supported actions ───────────────────────────────────

describe('other supported actions normalize', () => {
  it('edited: preserves the new title/body (old body gone, never fabricated)', () => {
    const ev = normalizePullRequestEvent(EDITED_FIXTURE, VERIFIED_CTX)!;
    const facts = asPullRequestFacts(ev!.payload)!;

    expect(ev!.sourceAction).toBe('edited');
    expect(facts.title).toBe('Add Postgres event store (revised)');
    expect(facts.body).toBe('Revised plan: use pgvector too.');
    expect(facts.updatedAt).toBe('2024-06-01T15:00:00.000Z');
  });

  it('reopened: state flips back to open', () => {
    const ev = normalizePullRequestEvent(REOPENED_FIXTURE, VERIFIED_CTX)!;
    const facts = asPullRequestFacts(ev!.payload)!;

    expect(ev!.sourceAction).toBe('reopened');
    expect(facts.state).toBe('open');
    expect(facts.merged).toBe(false);
  });
});

// ── Failure / boundary / security counterexamples ──────────────────────────

describe('unsupported actions are EXPLICITLY ignored (null, not silent drop)', () => {
  it('labeled → null', () => {
    expect(normalizePullRequestEvent(LABELED_FIXTURE, VERIFIED_CTX)).toBeNull();
  });

  it('review_requested → null', () => {
    expect(normalizePullRequestEvent(REVIEW_REQUESTED_FIXTURE, VERIFIED_CTX)).toBeNull();
  });

  it('missing action → null', () => {
    expect(normalizePullRequestEvent(MISSING_ACTION_FIXTURE, VERIFIED_CTX)).toBeNull();
  });
});

describe('malformed supported-action payloads raise (§5.1: never emit a half-fabricated event)', () => {
  it('supported action but no pull_request object → throws', () => {
    expect(() =>
      normalizePullRequestEvent(OPENED_WITH_NO_PR_FIXTURE, VERIFIED_CTX),
    ).toThrow(/pull_request/);
  });

  it('supported action but no repository → throws (cannot build stable externalId)', () => {
    expect(() =>
      normalizePullRequestEvent(OPENED_WITH_NO_REPO_FIXTURE, VERIFIED_CTX),
    ).toThrow(/repository/);
  });
});

describe('actor provenance (§5.4: preserve unknown as unknown, never fabricate)', () => {
  it('missing sender → actor=null (no system placeholder)', () => {
    const ev = normalizePullRequestEvent(OPENED_MISSING_SENDER_FIXTURE, VERIFIED_CTX)!;
    expect(ev.actor).toBeNull();
    // Verify result still parses (null actor is schema-valid).
    expect(() => normalizedEventSchema.parse(ev)).not.toThrow();
  });

  it('unverified webhook → actorProvenance=unknown (never webhook_verified unverified)', () => {
    const verified = normalizePullRequestEvent(OPENED_FIXTURE, VERIFIED_CTX)!;
    const unverified = normalizePullRequestEvent(OPENED_FIXTURE, UNVERIFIED_CTX)!;
    expect(verified.actorProvenance).toBe('webhook_verified');
    expect(unverified.actorProvenance).toBe('unknown');
  });
});

describe('time provenance (N8: time trust stated as a separate fact)', () => {
  it('provider timestamp present → occurredAt=provider time, provenance=provider', () => {
    const ev = normalizePullRequestEvent(OPENED_FIXTURE, VERIFIED_CTX)!;
    expect(ev.occurredAt).toBe('2024-06-01T12:00:00.000Z');
    expect(ev.occurredAtProvenance).toBe('provider');
  });

  it('no provider timestamps → falls back to server time, provenance=server', () => {
    const ev = normalizePullRequestEvent(OPENED_NO_TIMESTAMPS_FIXTURE, VERIFIED_CTX)!;
    expect(ev.occurredAt).toBe(SYNTHETIC_SERVER_RECEIVE_TIME);
    expect(ev.occurredAtProvenance).toBe('server');
  });

  it('only created_at (no updated_at) → uses created_at as provider time', () => {
    const fixture = {
      ...OPENED_FIXTURE,
      pull_request: {
        ...OPENED_FIXTURE.pull_request,
        updated_at: undefined,
        created_at: '2024-07-07T07:07:07Z',
      },
    };
    const ev = normalizePullRequestEvent(fixture, VERIFIED_CTX)!;
    expect(ev.occurredAt).toBe('2024-07-07T07:07:07.000Z');
    expect(ev.occurredAtProvenance).toBe('provider');
  });
});

// ── Security / redaction order (§5.3): parser preserves body, redaction strips later ─

describe('redaction order: parser preserves <private> verbatim; stripPrivateTags removes it', () => {
  it('parser does NOT pre-strip — body is the raw original', () => {
    const ev = normalizePullRequestEvent(OPENED_WITH_PRIVATE_BODY_FIXTURE, VERIFIED_CTX)!;
    const facts = asPullRequestFacts(ev!.payload)!;

    expect(facts.body).toContain('<private>');
    expect(facts.body).toContain('internal customer list: acme, bigco');
    expect(facts.body).toContain('</private>');
  });

  it('stripPrivateTags later removes the whole <private> section once', () => {
    const ev = normalizePullRequestEvent(OPENED_WITH_PRIVATE_BODY_FIXTURE, VERIFIED_CTX)!;
    const redacted = stripPrivateTags(ev.payload);
    const facts = asPullRequestFacts(redacted)!;

    expect(facts.body).toBe(
      'Plan: use Postgres.  do not leak.',
    );
    expect(facts.body).not.toContain('<private>');
    expect(facts.body).not.toContain('acme');
    expect(facts.body).not.toContain('bigco');
  });

  it('application of stripPrivateTags is idempotent (double-strip == single-strip)', () => {
    const ev = normalizePullRequestEvent(OPENED_WITH_PRIVATE_BODY_FIXTURE, VERIFIED_CTX)!;
    const once = stripPrivateTags(ev.payload);
    const twice = stripPrivateTags(once);
    expect(twice).toEqual(once);
  });
});

// ── Contract: the produced NormalizedEvent schema-validates ───────────────

describe('produced events validate against the connector producer contract', () => {
  it.each([
    ['opened', OPENED_FIXTURE],
    ['synchronize', SYNCHRONIZE_FIXTURE],
    ['closed-unmerged', CLOSED_UNMERGED_FIXTURE],
    ['merged', MERGED_FIXTURE],
    ['edited', EDITED_FIXTURE],
    ['reopened', REOPENED_FIXTURE],
  ])('%s — parsed by normalizedEventSchema', (_name, fixture) => {
    const ev = normalizePullRequestEvent(fixture, VERIFIED_CTX)!;
    expect(() => normalizedEventSchema.parse(ev)).not.toThrow();
  });

  it('actor=null case also validates', () => {
    const ev = normalizePullRequestEvent(OPENED_MISSING_SENDER_FIXTURE, VERIFIED_CTX)!;
    expect(() => normalizedEventSchema.parse(ev)).not.toThrow();
  });

  it('server-time fallback case also validates', () => {
    const ev = normalizePullRequestEvent(OPENED_NO_TIMESTAMPS_FIXTURE, VERIFIED_CTX)!;
    expect(() => normalizedEventSchema.parse(ev)).not.toThrow();
  });
});

// ── asPullRequestFacts narrowing ───────────────────────────────────────────

describe('asPullRequestFacts', () => {
  it('narrows a real PR payload', () => {
    const ev = normalizePullRequestEvent(OPENED_FIXTURE, VERIFIED_CTX)!;
    expect(asPullRequestFacts(ev.payload)).not.toBeNull();
  });

  it('returns null for a non-PR payload', () => {
    expect(asPullRequestFacts({ text: 'not a pr' })).toBeNull();
    expect(asPullRequestFacts({ action: 'x', number: 'not-a-number' })).toBeNull();
    expect(asPullRequestFacts(null as unknown as Record<string, unknown>)).toBeNull();
  });
});