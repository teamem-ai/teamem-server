/**
 * Redacted synthetic fixtures for the `pull_request` webhook normalizer
 * (DUA-144 / M0-GH-04).
 *
 * These are NOT shipped GitHub payloads: they are hand-built, data-only
 * snapshots modelled on GitHub's public `pull_request` webhook shape, with
 * every field replaced by synthetic values. No real tokens, logins, repos, or
 * user IDs appear here. This is the "脱敏后的 fixture" deliverable of the
 * task: fixtures live with the parser and never enter a production path.
 *
 * Fixtures cover the DUA-144 CLI acceptance set: opened, synchronize,
 * closed-unmerged, merged — plus the boundary cases the normalizer must handle
 * (edited title/body, reopened, unsupported action, missing sender, missing
 * repository, missing pull_request.number, body containing a `<private>`
 * section that redaction must later strip).
 */
import type { GithubPullRequestWebhook } from './pull-request.js';

// ── Shared envelope facts (synthetic, self-consistent across fixtures) ───────

export const SYNTHETIC_REPO_FULL_NAME = 'teamem-synth/demo-repo';
export const SYNTHETIC_PR_NUMBER = 1337;
export const SYNTHETIC_DELIVERY_ID = 'd1440000-0000-0000-0000-0000000000aa';
export const SYNTHETIC_SERVER_RECEIVE_TIME = '2024-06-01T12:34:56.000Z';

/** Webhook `sender` for a human author (synthetic id + login). */
export const SYNTHETIC_HUMAN_SENDER = {
  login: 'synthauthor',
  id: 424242,
  type: 'User',
} as const;

/** Webhook `sender` for a bot (synthetic). */
export const SYNTHETIC_BOT_SENDER = {
  login: 'synth-bot[bot]',
  id: 7777777,
  type: 'Bot',
} as const;

const SYNTHETIC_REPO = {
  full_name: SYNTHETIC_REPO_FULL_NAME,
  owner: { login: 'teamem-synth' },
  name: 'demo-repo',
} as const;

const SYNTHETIC_INSTALLATION = { id: 9_999_999 } as const;

// ── Fixtures recognized by the normalizer's supported-action gate ────────────

/** `pull_request` opened — state open, no merge, fresh title+body. */
export const OPENED_FIXTURE: GithubPullRequestWebhook = {
  action: 'opened',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'Add Postgres-backed event store',
    body: 'Closes #12. This introduces the events table and a pg-boss queue.',
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T12:00:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'b'.repeat(40) },
  },
};

/** `pull_request` synchronize — head advanced, same number, new updated_at. */
export const SYNTHETIC_INSTALLATION_FIXTURE = SYNTHETIC_INSTALLATION;

export const SYNCHRONIZE_FIXTURE: GithubPullRequestWebhook = {
  action: 'synchronize',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'Add Postgres-backed event store',
    body: 'Closes #12. Adds the events table and a pg-boss queue.',
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T12:20:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'c'.repeat(40) },
  },
};

/** `pull_request` closed WITHOUT merge — `merged: false`. */
export const CLOSED_UNMERGED_FIXTURE: GithubPullRequestWebhook = {
  action: 'closed',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'Add Postgres-backed event store',
    body: 'Closes #12. Superseded by the events-bus design.',
    state: 'closed',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-02T08:00:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'd'.repeat(40) },
  },
};

/** `pull_request` closed AND merged — action is STILL `closed`; merge fact is
 *  `pull_request.merged === true` + `merged_at`. This is the DUA-144 "merged"
 *  fixture: the only difference from CLOSED_UNMERGED is the merge fact, which
 *  the normalizer must preserve verbatim (§5.4). */
export const MERGED_FIXTURE: GithubPullRequestWebhook = {
  action: 'closed',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_BOT_SENDER, // a merge bot is the trigger actor here
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'Add Postgres-backed event store',
    body: 'Closes #12. Merged after review.',
    state: 'closed',
    merged: true,
    merged_at: '2024-06-02T08:05:00Z',
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-02T08:05:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'e'.repeat(40) },
  },
};

// ── Other supported-action fixtures ───────────────────────────────────────────

/** `edited` — title + body edited; old body is gone, not fabricated. */
export const EDITED_FIXTURE: GithubPullRequestWebhook = {
  action: 'edited',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'Add Postgres event store (revised)',
    body: 'Revised plan: use pgvector too.',
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T15:00:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'f'.repeat(40) },
  },
};

/** `reopened` — state flips back to open. */
export const REOPENED_FIXTURE: GithubPullRequestWebhook = {
  action: 'reopened',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'Add Postgres-backed event store',
    body: 'Reopening: we still want this.',
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-03T09:00:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'f'.repeat(40) },
  },
};

// ── Boundary / counterexample fixtures (NOT supported → `null`) ───────────────

/** `labeled` — metadata action M0 ignores; normalizer returns `null`. */
export const LABELED_FIXTURE: GithubPullRequestWebhook = {
  action: 'labeled',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'Add Postgres-backed event store',
    body: 'Closes #12.',
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T12:30:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'c'.repeat(40) },
  },
};

/** `review_requested` — another metadata action M0 ignores. */
export const REVIEW_REQUESTED_FIXTURE: GithubPullRequestWebhook = {
  action: 'review_requested',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'Add Postgres-backed event store',
    body: 'Closes #12.',
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T12:31:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/event-store', sha: 'c'.repeat(40) },
  },
};

// ── Boundary / counterexample fixtures (malformed → throw or downgrade) ────────

/** Missing `action` — unsupported-action gate returns `null`. */
export const MISSING_ACTION_FIXTURE: GithubPullRequestWebhook = {
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'x',
    body: null,
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T12:00:00Z',
  },
};

/** Supported action but `pull_request` object is absent → throws. */
export const OPENED_WITH_NO_PR_FIXTURE: GithubPullRequestWebhook = {
  action: 'opened',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
};

/** Supported action but repository absent → throws (no stable externalId). */
export const OPENED_WITH_NO_REPO_FIXTURE: GithubPullRequestWebhook = {
  action: 'opened',
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'x',
    body: null,
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T12:00:00Z',
  },
};

/** Missing `sender` — supported action, actor must be `null`, never fabricated. */
export const OPENED_MISSING_SENDER_FIXTURE: GithubPullRequestWebhook = {
  action: 'opened',
  repository: SYNTHETIC_REPO,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'No-sender PR',
    body: 'Actor unknown; must preserve as null.',
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T12:00:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/x', sha: 'c'.repeat(40) },
  },
};

/** No provider timestamps at all — occurredAt falls back to server time. */
export const OPENED_NO_TIMESTAMPS_FIXTURE: GithubPullRequestWebhook = {
  action: 'opened',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'No-time PR',
    body: null,
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/x', sha: 'c'.repeat(40) },
    user: { login: 'synthauthor', id: 424242, type: 'User' },
  },
};

/** Body carries a `<private>` section that must be stripped LATER by the
 *  redaction layer (§5.3). The normalizer preserves it verbatim; this fixture
 *  proves redaction happens exactly once, in the frozen order, not in the
 *  parser. */
export const OPENED_WITH_PRIVATE_BODY_FIXTURE: GithubPullRequestWebhook = {
  action: 'opened',
  repository: SYNTHETIC_REPO,
  sender: SYNTHETIC_HUMAN_SENDER,
  pull_request: {
    number: SYNTHETIC_PR_NUMBER,
    title: 'PR with secret context',
    body:
      'Plan: use Postgres. <private>internal customer list: acme, bigco</private> do not leak.',
    state: 'open',
    merged: false,
    merged_at: null,
    draft: false,
    created_at: '2024-06-01T12:00:00Z',
    updated_at: '2024-06-01T12:00:00Z',
    user: { login: 'synthauthor', id: 424242, type: 'User' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feat/x', sha: 'c'.repeat(40) },
  },
};