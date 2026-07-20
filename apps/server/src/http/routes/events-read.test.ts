/**
 * Unit tests for event DTO mapping — validates toSummary/toDetail shape
 * against the frozen Zod schemas without requiring a database.
 */
import { describe, expect, it } from 'vitest';
import { eventSummary, eventDetail } from '@teamem/schema';

describe('event DTO mapping unit tests', () => {
  // Simulate a database EventRow (the shape the repository returns after cast)
  const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'evt_test001',
    teamId: 'team_test',
    projectId: 'prj_test',
    channel: 'cli',
    kind: 'cli_init',
    connectorKind: 'cli',
    sourceEvent: null,
    sourceAction: null,
    deliveryId: 'del_001',
    itemKey: 'root',
    externalId: 'test/repo#1',
    url: null,
    actor: null,
    actorProvenance: 'unknown',
    actorPrincipalId: null,
    occurredAt: new Date('2026-07-17T00:00:00.000Z'),
    occurredAtProvenance: 'client',
    ingestedByCredentialId: 'key_test',
    ingestedByPrincipalId: null,
    payload: {
      schemaVersion: 1,
      repo: 'test/repo',
      commitSha: 'abc123def4567890123456789abcdef123456789',
      path: 'docs/test.md',
      content: 'test content',
    },
    payloadBytes: 100,
    payloadHash: 'abc123',
    payloadSchemaVersion: 1,
    envelopeVersion: 1,
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    ...overrides,
  });

  // Replicate the toSummary logic from events-read.ts
  function toSummary(row: ReturnType<typeof makeRow>): Record<string, unknown> {
    const sourceObj: Record<string, unknown> = {
      channel: row.channel,
      kind: row.kind,
      deliveryId: row.deliveryId,
      itemKey: row.itemKey,
      externalId: row.externalId,
    };
    if (row.sourceEvent) sourceObj['event'] = row.sourceEvent;
    if (row.sourceAction) sourceObj['action'] = row.sourceAction;
    if (row.url) sourceObj['url'] = row.url;
    if (row.channel === 'external') {
      sourceObj['connectorKind'] = row.connectorKind;
    }
    return {
      id: row.id,
      projectId: row.projectId,
      source: sourceObj,
      actor: row.actor,
      actorProvenance: row.actorProvenance,
      occurredAt: row.occurredAt.toISOString(),
      occurredAtProvenance: row.occurredAtProvenance,
      ingestedBy: {
        credentialId: row.ingestedByCredentialId,
        principalId: row.ingestedByPrincipalId,
      },
      payloadBytes: row.payloadBytes,
      createdAt: row.createdAt.toISOString(),
    };
  }

  function toDetail(row: ReturnType<typeof makeRow>): Record<string, unknown> {
    return {
      ...toSummary(row),
      payload: row.payload,
    };
  }

  it('toSummary produces valid EventSummary for cli_init', () => {
    const row = makeRow();
    const result = eventSummary.safeParse(toSummary(row));
    if (!result.success) {
      console.error('Summary parse errors:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('toDetail produces valid EventDetail for cli_init', () => {
    const row = makeRow();
    const result = eventDetail.safeParse(toDetail(row));
    if (!result.success) {
      console.error('Detail parse errors:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('toSummary for external channel includes connectorKind', () => {
    const row = makeRow({
      channel: 'external',
      kind: 'external_event',
      connectorKind: 'slack',
    });
    const result = eventSummary.safeParse(toSummary(row));
    if (!result.success) {
      console.error('External summary parse errors:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
    const data = result.data!;
    expect(data.source.channel).toBe('external');
    expect(data.source.connectorKind).toBe('slack');
  });

  it('toSummary with url and sourceEvent validates', () => {
    const row = makeRow({
      sourceEvent: 'push',
      sourceAction: 'created',
      url: 'https://github.com/test/repo/pull/1',
    });
    const result = eventSummary.safeParse(toSummary(row));
    if (!result.success) {
      console.error('With url parse errors:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('toSummary with github channel validates', () => {
    const row = makeRow({
      channel: 'github',
      kind: 'github_pr',
      connectorKind: 'github',
      sourceEvent: 'pull_request',
    });
    const result = eventSummary.safeParse(toSummary(row));
    if (!result.success) {
      console.error('GitHub summary parse errors:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });
});
