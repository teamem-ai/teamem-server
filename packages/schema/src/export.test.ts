/**
 * Executable verification of the OKF bundle format contract (DUA-248 /
 * M3-EXPORT-01). Each test pins one contract rule:
 *   - bundle layout: index.md + log.md + per-type dirs (rule 1);
 *   - per-concept frontmatter, UUID preserved (rule 2);
 *   - teamem://concept/<uuid> → relative Markdown link resolution (rule 3);
 *   - round-trip compatibility (v0.3 additive).
 */
import { describe, expect, it } from 'vitest';
import {
  concept,
  CONTRACT_ADDITIVE_CHANGES,
  type Concept,
} from './index.js';
import {
  escapeMarkdownLinkText,
  extractTeamemLinks,
  okfBundleEntryFromConcept,
  okfConceptFrontmatter,
  okfConceptRelPath,
  okfReservedFrontmatter,
  OKF_BUNDLE_INDEX_FILE,
  OKF_BUNDLE_LOG_FILE,
  OKF_FORMAT_VERSION,
  OKF_RESERVED_FILES,
  OKF_TYPE_DIRS,
  OKF_TYPE_DIR_MAP,
  parseConceptPage,
  parseOkfPage,
  relativeMarkdownLink,
  renderBundleIndex,
  renderBundleLog,
  renderConceptFrontmatter,
  renderConceptPage,
  renderOkfReservedFrontmatter,
  resolveTeamemLinks,
  splitOkfPage,
  teamemLinkUuid,
} from './export.js';

// ── Fixture: a full concept DTO (contract shape, contributors are refs) ────
const UUID_DECISION = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const UUID_GOTCHA = 'b4cc2aef-9ca0-4999-aa23-bdf5e7654113';
const UUID_OPTIONS = 'c5dd3bff-0ab1-4aaa-bb34-ce06f8765224';

function buildConcept(overrides: Partial<Concept> = {}): Concept {
  return concept.parse({
    uuid: UUID_DECISION,
    path: 'mysql-for-orders',
    type: 'decision',
    status: 'active',
    confidence: 'high',
    title: 'Use MySQL for orders',
    tags: ['database', 'orders'],
    lastConfirmed: '2026-07-10T09:30:00.000Z',
    schemaVersion: 1,
    firstSeen: '2026-05-12T00:00:00.000Z',
    contributors: [
      {
        principalId: 'pri_01H',
        kind: 'human',
        provider: 'github',
        displayName: 'octocat',
        githubLogin: 'octocat',
      },
    ],
    evidence: [
      {
        kind: 'pr',
        ref: 'https://github.com/org/repo/pull/42',
        at: '2026-07-10T09:30:00.000Z',
      },
    ],
    supersedes: null,
    aliases: [],
    body: 'See [MySQL](teamem://concept/b4cc2aef-9ca0-4999-aa23-bdf5e7654113).',
    createdAt: '2026-05-12T00:00:00.000Z',
    ...overrides,
  });
}

const gotcha = buildConcept({
  uuid: UUID_GOTCHA,
  path: 'sequelize-type-cast',
  type: 'gotcha',
  status: 'active',
  confidence: 'medium',
  title: 'Sequelize type cast drops decimals',
  lastConfirmed: '2026-07-12T14:05:00.000Z',
  firstSeen: '2026-06-01T09:00:00.000Z',
  createdAt: '2026-06-01T09:00:00.000Z',
  body: 'Blocked on [MySQL decision](teamem://concept/a3bb189e-8bf9-3888-9912-ace4e6543002).',
});

const convention = buildConcept({
  uuid: UUID_OPTIONS,
  path: 'migrations/sql-up',
  type: 'convention',
  status: 'active',
  confidence: 'high',
  title: 'Migrations use SQL UP',
  lastConfirmed: '2026-07-10T09:30:00.000Z',
  firstSeen: '2026-05-20T00:00:00.000Z',
  createdAt: '2026-05-20T00:00:00.000Z',
  body: 'See [gotcha](teamem://concept/b4cc2aef-9ca0-4999-aa23-bdf5e7654113).',
});

// ── Rule 1: bundle layout (index.md + log.md + per-type dirs) ──────────────
describe('bundle layout (DUA-248 rule 1)', () => {
  it('freezes exactly the six type directories, one per concept type', () => {
    expect(OKF_TYPE_DIRS).toEqual([
      'decisions',
      'gotchas',
      'conventions',
      'runbooks',
      'services',
      'concepts',
    ]);
    expect(Object.keys(OKF_TYPE_DIR_MAP).sort()).toEqual(
      [
        'decision',
        'gotcha',
        'convention',
        'runbook',
        'service',
        'concept',
      ].sort(),
    );
  });

  it('reserves index.md and log.md at the bundle root', () => {
    expect(OKF_RESERVED_FILES).toEqual(['index.md', 'log.md']);
    expect(OKF_BUNDLE_INDEX_FILE).toBe('index.md');
    expect(OKF_BUNDLE_LOG_FILE).toBe('log.md');
  });

  it('maps every concept type to its directory', () => {
    expect(okfConceptRelPath('decision', 'mysql-for-orders')).toBe(
      'decisions/mysql-for-orders.md',
    );
    expect(okfConceptRelPath('gotcha', 'sequelize-type-cast')).toBe(
      'gotchas/sequelize-type-cast.md',
    );
    expect(okfConceptRelPath('convention', 'migrations/sql-up')).toBe(
      'conventions/migrations/sql-up.md',
    );
    expect(okfConceptRelPath('runbook', 'incident/rollback')).toBe(
      'runbooks/incident/rollback.md',
    );
    expect(okfConceptRelPath('service', 'auth-api')).toBe('services/auth-api.md');
    expect(okfConceptRelPath('concept', 'teamem/okf')).toBe(
      'concepts/teamem/okf.md',
    );
  });

  it('rejects a path that violates the frozen path syntax', () => {
    for (const bad of ['AuthAPI', '../etc', '/lead', 'a//b', 'a b', 'x.md']) {
      expect(() => okfConceptRelPath('decision', bad)).toThrow();
    }
  });

  it('renders index.md as a catalog grouped by type dir in frozen order', () => {
    const index = renderBundleIndex([
      okfBundleEntryFromConcept(gotcha),
      okfBundleEntryFromConcept(convention),
      okfBundleEntryFromConcept(buildConcept()),
    ]);

    // Reserved frontmatter first (only okf_version at the bundle root).
    expect(index.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true);

    // Per-type sections in frozen dir order: decisions before gotchas before
    // conventions.
    const decisions = index.indexOf('## decisions');
    const gotchas = index.indexOf('## gotchas');
    const conventions = index.indexOf('## conventions');
    expect(decisions).toBeGreaterThan(-1);
    expect(gotchas).toBeGreaterThan(decisions);
    expect(conventions).toBeGreaterThan(gotchas);

    // Relative links from the bundle root point straight at the pages.
    expect(index).toContain(
      '[Use MySQL for orders](./decisions/mysql-for-orders.md)',
    );
    expect(index).toContain('[Sequelize type cast drops decimals](./gotchas/sequelize-type-cast.md)');
    expect(index).toContain(
      '[Migrations use SQL UP](./conventions/migrations/sql-up.md)',
    );
  });

  it('renders log.md newest lastConfirmed first with a uuid tie-break', () => {
    const log = renderBundleLog([
      okfBundleEntryFromConcept(convention), // 2026-07-10
      okfBundleEntryFromConcept(gotcha), // 2026-07-12 — newest
      okfBundleEntryFromConcept(buildConcept()), // 2026-07-10
    ]);

    expect(log.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true);
    const gotchaLine = log.indexOf('gotchas/sequelize-type-cast.md');
    const decisionLine = log.indexOf('decisions/mysql-for-orders.md');
    const conventionLine = log.indexOf('conventions/migrations/sql-up.md');
    expect(gotchaLine).toBeGreaterThan(-1);
    expect(gotchaLine).toBeLessThan(decisionLine);
    expect(decisionLine).toBeLessThan(conventionLine);

    // Every entry carries the canonical UUID — nothing is lost in the log.
    expect(log).toContain(`(${UUID_GOTCHA})`);
    expect(log).toContain(`(${UUID_DECISION})`);
    expect(log).toContain(`(${UUID_OPTIONS})`);
  });

  it('omits empty type sections from index.md', () => {
    const index = renderBundleIndex([okfBundleEntryFromConcept(gotcha)]);
    expect(index).not.toContain('## runbooks');
    expect(index).not.toContain('## services');
    expect(index).not.toContain('## concepts');
    expect(index).toContain('## gotchas');
  });

  it('reserved frontmatter round-trips and rejects anything else', () => {
    const text = renderBundleIndex([okfBundleEntryFromConcept(gotcha)]);
    const parsed = parseOkfPage(okfReservedFrontmatter, text);
    expect(parsed).not.toBeNull();
    expect(parsed!.data).toEqual({ okf_version: OKF_FORMAT_VERSION });
    // A concept page is not a valid reserved file: the strict schema rejects
    // the extra concept keys, so the parse fails cleanly.
    expect(
      parseOkfPage(
        okfReservedFrontmatter,
        renderConceptPage(buildConcept(), {
          sourceRelPath: 'decisions/mysql-for-orders.md',
          uuidToBundlePath: new Map(),
        }),
      ),
    ).toBeNull();
    expect(
      parseOkfPage(okfReservedFrontmatter, '---\nokf_version: "9.9"\n---\n'),
    ).toBeNull();
  });
});

// ── Rule 2: per-concept frontmatter, UUID preserved ────────────────────────
describe('per-concept frontmatter (DUA-248 rule 2)', () => {
  it('renders a fenced YAML block with the canonical UUID preserved', () => {
    const fm = renderConceptFrontmatter(buildConcept());
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm.endsWith('---\n')).toBe(true);
    expect(fm).toContain(`uuid: ${UUID_DECISION}`);
    expect(fm).toContain('type: decision');
    expect(fm).toContain('path: mysql-for-orders');
    expect(fm).toContain('status: active');
    expect(fm).toContain('confidence: high');
    expect(fm).toContain('title: Use MySQL for orders');
    expect(fm).toContain('schemaVersion: 1');
    expect(fm).toContain('supersedes: null');
  });

  it('renders the evidence and contributors verbatim for round-trip', () => {
    const fm = renderConceptFrontmatter(buildConcept());
    expect(fm).toContain('https://github.com/org/repo/pull/42');
    expect(fm).toContain('principalId: pri_01H');
  });

  it('round-trips: frontmatter + body recover the concept metadata exactly', () => {
    const conceptDto = buildConcept();
    const expected = okfConceptFrontmatter.parse({
      type: conceptDto.type,
      uuid: conceptDto.uuid,
      path: conceptDto.path,
      status: conceptDto.status,
      confidence: conceptDto.confidence,
      title: conceptDto.title,
      tags: conceptDto.tags,
      lastConfirmed: conceptDto.lastConfirmed,
      firstSeen: conceptDto.firstSeen,
      createdAt: conceptDto.createdAt,
      schemaVersion: conceptDto.schemaVersion,
      supersedes: conceptDto.supersedes,
      aliases: conceptDto.aliases,
      contributors: conceptDto.contributors,
      evidence: conceptDto.evidence,
    });
    const page = renderConceptPage(conceptDto, {
      sourceRelPath: 'decisions/mysql-for-orders.md',
      uuidToBundlePath: new Map([
        [UUID_GOTCHA, okfConceptRelPath('gotcha', 'sequelize-type-cast')],
      ]),
    });
    const parsed = parseConceptPage(page);
    expect(parsed).not.toBeNull();
    expect(parsed!.data).toEqual(expected);
  });

  it('round-trips the full concept fields (not just the summary)', () => {
    const c = buildConcept({
      supersedes: UUID_OPTIONS,
      aliases: ['orders-db'],
      contributors: [
        {
          principalId: 'pri_02J',
          kind: 'service',
          provider: 'github-action',
          displayName: 'github-action',
        },
      ],
      evidence: [
        {
          kind: 'repo_file',
          repo: 'org/repo',
          commitSha: '3a8a7e7',
          path: 'docs/adr/0001-mysql.md',
          at: '2026-07-10T09:30:00.000Z',
        },
      ],
      tags: [],
    });
    const page = renderConceptPage(c, {
      sourceRelPath: 'decisions/mysql-for-orders.md',
      uuidToBundlePath: new Map(),
    });
    const parsed = parseConceptPage(page);
    expect(parsed).not.toBeNull();
    expect(parsed!.data.supersedes).toBe(UUID_OPTIONS);
    expect(parsed!.data.aliases).toEqual(['orders-db']);
    expect(parsed!.data.contributors[0]!.provider).toBe('github-action');
    expect(parsed!.data.evidence[0]!.kind).toBe('repo_file');
    expect(parsed!.data.tags).toEqual([]);
  });

  it('rejects a page without frontmatter and a page with the uuid removed', () => {
    expect(parseConceptPage('# Plain markdown')).toBeNull();
    expect(parseConceptPage('')).toBeNull();
    const pages = renderConceptPage(buildConcept(), {
      sourceRelPath: 'index.md',
      uuidToBundlePath: new Map(),
    });
    expect(parseConceptPage(pages.replace(`uuid: ${UUID_DECISION}`, ''))).toBeNull();
    const fm = renderConceptFrontmatter(buildConcept());
    expect(parseConceptPage(`${fm}# x\n`)).not.toBeNull();
    // strict object: an unknown key is rejected, mirroring the frozen DTOs.
    expect(
      okfConceptFrontmatter.safeParse({
        type: 'decision',
        uuid: UUID_DECISION,
        path: 'mysql-for-orders',
        status: 'active',
        confidence: 'high',
        title: 'T',
        tags: [],
        lastConfirmed: '2026-07-10T09:30:00.000Z',
        firstSeen: '2026-05-12T00:00:00.000Z',
        createdAt: '2026-05-12T00:00:00.000Z',
        schemaVersion: 1,
        supersedes: null,
        aliases: [],
        contributors: [],
        evidence: [
          {
            kind: 'pr',
            ref: 'https://github.com/org/repo/pull/42',
            at: '2026-07-10T09:30:00.000Z',
          },
        ],
        surprise: true,
      }).success,
    ).toBe(false);
  });

  it('upholds the evidence red line in the exported format', () => {
    const fm = renderConceptFrontmatter(buildConcept());
    expect(parseConceptPage(`${fm}# x\n`)!.data.evidence.length).toBeGreaterThan(0);
    expect(
      okfConceptFrontmatter.safeParse({
        type: 'decision',
        uuid: UUID_DECISION,
        path: 'mysql-for-orders',
        status: 'active',
        confidence: 'high',
        title: 'T',
        tags: [],
        lastConfirmed: '2026-07-10T09:30:00.000Z',
        firstSeen: '2026-05-12T00:00:00.000Z',
        createdAt: '2026-05-12T00:00:00.000Z',
        schemaVersion: 1,
        supersedes: null,
        aliases: [],
        contributors: [],
        evidence: [],
      }).success,
    ).toBe(false);
  });

  it('splitOkfPage separates frontmatter from body and rejects bare markdown', () => {
    const page = renderConceptPage(buildConcept(), {
      sourceRelPath: 'index.md',
      uuidToBundlePath: new Map(),
    });
    const split = splitOkfPage(page);
    expect(split).not.toBeNull();
    expect(split!.body.trim()).toBe(buildConcept().body);
    expect(splitOkfPage('# no frontmatter')).toBeNull();
    expect(splitOkfPage('')).toBeNull();
  });
});

// ── Rule 3: teamem://concept/<uuid> → relative Markdown link resolution ────
describe('link resolution (DUA-248 rule 3)', () => {
  const map = new Map<string, string>([
    [UUID_GOTCHA, 'gotchas/sequelize-type-cast.md'],
    [UUID_OPTIONS, 'conventions/migrations/sql-up.md'],
  ]);

  it('resolves links inside markdown link destinations from the same type dir', () => {
    const body = `See [MySQL](teamem://concept/${UUID_GOTCHA}) for details.`;
    expect(resolveTeamemLinks(body, 'decisions/mysql-for-orders.md', map)).toBe(
      `See [MySQL](../gotchas/sequelize-type-cast.md) for details.`,
    );
  });

  it('resolves bare occurrences at the bundle root with a ./ prefix', () => {
    const body = `Blocked on teamem://concept/${UUID_GOTCHA}.`;
    expect(resolveTeamemLinks(body, 'index.md', map)).toBe(
      `Blocked on ./gotchas/sequelize-type-cast.md.`,
    );
  });

  it('computes one ../ per source directory level (nested paths)', () => {
    const body = `See teamem://concept/${UUID_OPTIONS}.`;
    expect(resolveTeamemLinks(body, 'runbooks/incident/rollback.md', map)).toBe(
      `See ../../conventions/migrations/sql-up.md.`,
    );
  });

  it('leaves unresolved UUIDs untouched — honest and round-trip recoverable', () => {
    const body = `Missing teamem://concept/${UUID_DECISION} target.`;
    expect(resolveTeamemLinks(body, 'index.md', map)).toBe(body);
  });

  it('extracts every teamem link and parses uuids from the frozen pattern', () => {
    const body = `[a](teamem://concept/${UUID_GOTCHA}) teamem://concept/${UUID_OPTIONS} teamem://concept/not-a-uuid`;
    expect(extractTeamemLinks(body)).toEqual([
      `teamem://concept/${UUID_GOTCHA}`,
      `teamem://concept/${UUID_OPTIONS}`,
    ]);
    expect(teamemLinkUuid(`teamem://concept/${UUID_GOTCHA}`)).toBe(UUID_GOTCHA);
    expect(teamemLinkUuid('teamem://concept/not-a-uuid')).toBeNull();
    expect(teamemLinkUuid('https://example.com')).toBeNull();
  });

  it('matches exactly the UUID syntax the frozen conceptLinkPattern allows', () => {
    // Lockstep guard: the body scanner and the single-URI validator must agree.
    const candidate = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
    const uri = `teamem://concept/${candidate}`;
    expect(teamemLinkUuid(uri)).toBe(candidate);
  });

  it('renders a full page with frontmatter and resolved body', () => {
    const page = renderConceptPage(buildConcept(), {
      sourceRelPath: 'decisions/mysql-for-orders.md',
      uuidToBundlePath: map,
    });
    expect(page).toContain(`uuid: ${UUID_DECISION}`);
    expect(page).toContain(`[MySQL](../gotchas/sequelize-type-cast.md)`);
  });

  it('computes relative links between arbitrary bundle files', () => {
    expect(relativeMarkdownLink('index.md', 'services/auth-api.md')).toBe(
      './services/auth-api.md',
    );
    expect(relativeMarkdownLink('log.md', 'services/auth-api.md')).toBe(
      './services/auth-api.md',
    );
    expect(relativeMarkdownLink('decisions/db/mysql.md', 'services/auth-api.md')).toBe(
      '../../services/auth-api.md',
    );
  });

  it('escapes brackets in index link labels', () => {
    expect(escapeMarkdownLinkText('Use [brackets] here')).toBe(
      'Use \\[brackets\\] here',
    );
  });
});

// ── v0.3 additive registration ─────────────────────────────────────────────
describe('contract registration (DUA-248)', () => {
  it('registers the OKF bundle format in the additive changelog', () => {
    expect(
      CONTRACT_ADDITIVE_CHANGES.some((c) => c.change.includes('DUA-248')),
    ).toBe(true);
    const entry = CONTRACT_ADDITIVE_CHANGES.find((c) =>
      c.change.includes('DUA-248'),
    )!;
    // The format change explicitly enumerates the export impact.
    expect(entry.impact.export.length).toBeGreaterThan(0);
    expect(entry.impact.database.startsWith('None')).toBe(true);
  });

  it('keeps the OKF format version aligned with the emitted frontmatter', () => {
    expect(renderConceptFrontmatter(buildConcept())).not.toContain('okf_version');
    expect(renderOkfReservedFrontmatter()).toContain(OKF_FORMAT_VERSION);
  });
});