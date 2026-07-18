/**
 * Mechanical verification of Contract v0.2 Appendix A.
 * Each test pins a specific frozen decision (Q/N reference in the name).
 */
import { describe, expect, it } from 'vitest';
import {
  apiScope,
  auditItem,
  concept,
  conceptListQuery,
  conceptPath,
  cursorPayload,
  decodeCursor,
  encodeCursor,
  eventSummary,
  evidence,
  ingestEventRequest,
  jobEventResult,
  principalId,
  source,
  teamRole,
  CONTRACT_ADDITIVE_CHANGES,
  CONTRACT_STATUS,
  KNOWN_AUDIT_ACTIONS,
  type CursorPayload,
} from './index.js';

const validIngest = {
  projectId: 'prj_abc123',
  source: { kind: 'cli_init', externalId: 'org/repo:src/auth.ts' },
  payload: {
    schemaVersion: 1,
    repo: 'org/repo',
    commitSha: '3a8a7e7c9b1d2f4e5a6b7c8d9e0f1a2b3c4d5e6f',
    path: 'src/auth.ts',
    content: 'export const x = 1;',
  },
  idempotencyKey: 'sha256-of-repo-sha-path',
} as const;

describe('ingest (contract ②)', () => {
  it('accepts a valid cli_init request and applies option defaults (Q8)', () => {
    const parsed = ingestEventRequest.parse(validIngest);
    expect(parsed.options).toEqual({ compile: true, wait: false });
  });

  it('rejects github kinds on the public channel — internal connector only (N2-③)', () => {
    const bad = {
      ...validIngest,
      source: { kind: 'github_pr', externalId: 'org/repo#42' },
    };
    expect(ingestEventRequest.safeParse(bad).success).toBe(false);
  });

  it('requires idempotencyKey (N1)', () => {
    const rest: Record<string, unknown> = { ...validIngest };
    delete rest['idempotencyKey'];
    expect(ingestEventRequest.safeParse(rest).success).toBe(false);
  });
});

describe('source (generic connector channel — v0.3 additive, DUA-129)', () => {
  const base = {
    kind: 'external_event',
    deliveryId: 'Ev123',
    itemKey: 'root',
    externalId: 'C042/p1746992',
  } as const;

  it('accepts a private-connector event on the generic external channel with connectorKind', () => {
    const parsed = source.safeParse({
      ...base,
      channel: 'external',
      connectorKind: 'slack',
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts built-in channels without connectorKind (no field bloat)', () => {
    const parsed = source.safeParse({
      channel: 'cli',
      kind: 'cli_init',
      deliveryId: 'idem-1',
      itemKey: 'root',
      externalId: 'org/repo:src/auth.ts',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown fields — connectorKind is the only new surface (strict object)', () => {
    const bad = source.safeParse({
      ...base,
      channel: 'external',
      connectorKind: 'slack',
      somethingElse: 'nope',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects channel=external with no connectorKind (acceptance-review fix: was a silent pass)', () => {
    const bad = source.safeParse({ ...base, channel: 'external' });
    expect(bad.success).toBe(false);
  });

  it('rejects a built-in channel carrying a connectorKind (acceptance-review fix: was a silent pass)', () => {
    const bad = source.safeParse({
      channel: 'cli',
      kind: 'cli_init',
      deliveryId: 'idem-1',
      itemKey: 'root',
      externalId: 'org/repo:src/auth.ts',
      connectorKind: 'cli',
    });
    expect(bad.success).toBe(false);
  });

  it('a persisted Slack-like actor round-trips through eventSummary (acceptance-review fix: actor.provider is open)', () => {
    // Closes the exact gap the acceptance review found: source.channel
    // allowed 'external' but actor.provider was still closed to ['github'],
    // so a genuinely-persisted Slack/Gmail actor could never pass this DTO.
    const parsed = eventSummary.safeParse({
      id: 'evt_01H',
      projectId: 'prj_abc123',
      source: { ...base, channel: 'external', connectorKind: 'slack' },
      actor: {
        kind: 'human',
        provider: 'slack',
        providerUserId: 'U123',
        displayLogin: 'alice',
      },
      actorProvenance: 'webhook_verified',
      occurredAt: '2026-07-17T00:00:00.000Z',
      occurredAtProvenance: 'provider',
      ingestedBy: { credentialId: null, principalId: null },
      payloadBytes: 37,
      createdAt: '2026-07-17T00:00:01.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('the contract honestly reports its status once diverged from the frozen base, with an enumerated changelog', () => {
    expect(CONTRACT_STATUS).not.toBe('v0.2-frozen');
    expect(CONTRACT_ADDITIVE_CHANGES.length).toBeGreaterThan(0);
    expect(CONTRACT_ADDITIVE_CHANGES.some((c) => c.change.includes('DUA-129'))).toBe(true);
  });
});

describe('concept (contract ①)', () => {
  const validConcept = {
    uuid: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    path: 'services/auth-api',
    type: 'service',
    status: 'active',
    confidence: 'high',
    title: 'Auth API',
    tags: ['auth'],
    lastConfirmed: '2026-07-10T09:30:00.000Z',
    schemaVersion: 1,
    firstSeen: '2026-05-12T00:00:00.000Z',
    contributors: ['pri_01H'],
    evidence: [
      {
        kind: 'pr',
        ref: 'https://github.com/org/repo/pull/42',
        at: '2026-07-10T09:30:00.000Z',
      },
    ],
    supersedes: null,
    aliases: [],
    body: 'See [Auth API](teamem://concept/a3bb189e-8bf9-3888-9912-ace4e6543002).',
    createdAt: '2026-05-12T00:00:00.000Z',
  } as const;

  it('accepts a valid concept', () => {
    expect(concept.safeParse(validConcept).success).toBe(true);
  });

  it('rejects a concept without evidence — every page carries evidence (red line)', () => {
    expect(concept.safeParse({ ...validConcept, evidence: [] }).success).toBe(false);
  });

  it('rejects repo_file evidence without an immutable commitSha (Q2)', () => {
    const bad = evidence.safeParse({
      kind: 'repo_file',
      repo: 'org/repo',
      path: 'src/auth.ts',
      at: '2026-07-16T02:00:00.000Z',
    });
    expect(bad.success).toBe(false);
    const good = evidence.safeParse({
      kind: 'repo_file',
      repo: 'org/repo',
      commitSha: '3a8a7e7',
      path: 'src/auth.ts',
      at: '2026-07-16T02:00:00.000Z',
    });
    expect(good.success).toBe(true);
  });

  it('rejects unsafe paths — frozen syntax (N5)', () => {
    for (const bad of ['../etc', 'Services/Auth', '/lead', 'a//b', 'a b']) {
      expect(conceptPath.safeParse(bad).success, bad).toBe(false);
    }
    expect(conceptPath.safeParse('decisions/orders-mysql').success).toBe(true);
  });
});

describe('pagination & cursor (N3/Q11)', () => {
  it('rejects limit > 100 instead of clamping (Q11) and defaults to 20', () => {
    const over = conceptListQuery.safeParse({ projectId: 'prj_a', limit: 150 });
    expect(over.success).toBe(false);
    const parsed = conceptListQuery.parse({ projectId: 'prj_a' });
    expect(parsed.limit).toBe(20);
  });

  it('round-trips a cursor and rejects tampered tokens (N3: untrusted input)', () => {
    const payload: CursorPayload = {
      v: 1,
      resource: 'concepts',
      projectId: 'prj_abc123',
      sort: 'last_confirmed',
      position: { sortValue: '2026-07-10T09:30:00.000Z', id: 'uuid-x' },
      filterHash: 'fh_1',
    };
    const token = encodeCursor(payload);
    expect(decodeCursor(token)).toEqual(payload);
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('{"v":2}').toString('base64url'))).toBeNull();
  });

  it('rejects invalid resource/sort combinations — cursor is a discriminated union (N8)', () => {
    const bad = cursorPayload.safeParse({
      v: 1,
      resource: 'concepts',
      projectId: 'prj_abc123',
      sort: 'created_at', // concepts sort by last_confirmed — inexpressible combo
      position: { sortValue: '2026-07-10T09:30:00.000Z', id: 'x' },
      filterHash: 'fh_1',
    });
    expect(bad.success).toBe(false);
  });
});

describe('identity & authorization vocabulary (N2/N6/N7)', () => {
  it('principal ids use the pri_ prefix', () => {
    expect(principalId.safeParse('pri_01H').success).toBe(true);
    expect(principalId.safeParse('mem_01H').success).toBe(false);
  });

  it('freezes exactly four API scopes and four team roles (N6/N7)', () => {
    expect(apiScope.options).toHaveLength(4);
    expect(teamRole.options).toEqual(['viewer', 'member', 'admin', 'owner']);
  });
});

describe('job per-event results (N4 — discriminated union, no ambiguity)', () => {
  it('failed requires a sanitized error; skipped requires a reason', () => {
    expect(
      jobEventResult.safeParse({ eventId: 'evt_1', status: 'failed' }).success,
    ).toBe(false);
    expect(
      jobEventResult.safeParse({
        eventId: 'evt_1',
        status: 'failed',
        error: { code: 'compile_error', message: 'extraction failed' },
      }).success,
    ).toBe(true);
    expect(
      jobEventResult.safeParse({ eventId: 'evt_1', status: 'skipped' }).success,
    ).toBe(false);
    expect(
      jobEventResult.safeParse({
        eventId: 'evt_1',
        status: 'skipped',
        reason: 'no_knowledge',
      }).success,
    ).toBe(true);
  });
});

describe('audit (N7 — open action registry)', () => {
  const baseAudit = {
    id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    createdAt: '2026-07-17T00:00:00.000Z',
    requestId: 'req_1',
    principalId: null,
    credentialId: 'key_abc',
    resourceType: 'event',
    resourceId: 'evt_1',
    teamId: 'team_abc',
    projectId: null,
    outcome: 'success',
  } as const;

  it('tolerates unknown action strings from newer servers (forward compat)', () => {
    expect(KNOWN_AUDIT_ACTIONS).toContain('event.ingest');
    expect(
      auditItem.safeParse({ ...baseAudit, action: 'future.new_action' }).success,
    ).toBe(true);
  });
});
