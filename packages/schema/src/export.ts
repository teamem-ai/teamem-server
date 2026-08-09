/**
 * OKF bundle format contract. (Contract v0.3 additive — DUA-248 / M3-EXPORT-01.)
 *
 * Teamem's binding of the Open Knowledge Format (OKF): an exported project is
 * a directory of Markdown files with YAML frontmatter — a knowledge graph
 * that stays readable by humans and agents without teamem. Exports are
 * round-trip compatible: a concept page can be reconstructed from the
 * frontmatter and body, and the canonical UUID is never lost (N5).
 *
 * Bundle layout (fixed, deterministic):
 *
 *   <bundle-root>/
 *     index.md                  reserved OKF root index — catalog of the bundle
 *     log.md                    reserved OKF change log — newest first
 *     decisions/<path>.md       one page per concept, grouped by type dir
 *     gotchas/<path>.md
 *     conventions/<path>.md
 *     runbooks/<path>.md
 *     services/<path>.md
 *     concepts/<path>.md
 *
 * Every non-reserved page is a concept page:
 *
 *   ---
 *   type: decision
 *   uuid: a3bb189e-8bf9-3888-9912-ace4e6543002
 *   ...  (full shape: okfConceptFrontmatter)
 *   ---
 *
 *   <markdown body; every teamem://concept/<uuid> link is resolved to a
 *   relative Markdown path; unresolved UUIDs keep the canonical URI>
 *
 * The pure functions in this module ARE the executable contract text. They do
 * no file I/O, HTTP, or persistence — the export writer (M3-EXPORT-02) and
 * the future import endpoint compose them.
 */
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { conceptUuid, isoDateTime } from './common.js';
import {
  conceptLinkPattern,
  conceptPath,
  conceptStatus,
  conceptType,
  confidence,
  evidence,
  principalRef,
  type Concept,
  type ConceptType,
} from './concept.js';
import { CONCEPT_SCHEMA_VERSION } from './common.js';

// ── Versions and reserved files ────────────────────────────────────────────
/**
 * The OKF specification version this bundle format emits. `okf_version` is
 * the only frontmatter key the OKF spec permits on a bundle-root index page
 * (okflint R001), and the same minimal header is used on `log.md`.
 */
export const OKF_FORMAT_VERSION = '0.1' as const;

export const OKF_BUNDLE_INDEX_FILE = 'index.md' as const;
export const OKF_BUNDLE_LOG_FILE = 'log.md' as const;
export const OKF_RESERVED_FILES = [
  OKF_BUNDLE_INDEX_FILE,
  OKF_BUNDLE_LOG_FILE,
] as const;
export type OkfReservedFile = (typeof OKF_RESERVED_FILES)[number];

/** Minimal frontmatter of the reserved `index.md` / `log.md` files. */
export const okfReservedFrontmatter = z.strictObject({
  okf_version: z.literal(OKF_FORMAT_VERSION),
});
export type OkfReservedFrontmatter = z.infer<typeof okfReservedFrontmatter>;

/** `---` delimited header used by the reserved files. */
export function renderOkfReservedFrontmatter(): string {
  return `---\nokf_version: "${OKF_FORMAT_VERSION}"\n---\n`;
}

// ── Per-type directories (rule: one directory per concept type) ────────────
export const OKF_TYPE_DIRS = [
  'decisions',
  'gotchas',
  'conventions',
  'runbooks',
  'services',
  'concepts',
] as const;
export type OkfTypeDir = (typeof OKF_TYPE_DIRS)[number];

/** Frozen mapping of concept type → bundle directory name (1:1, plural). */
export const OKF_TYPE_DIR_MAP: Readonly<Record<ConceptType, OkfTypeDir>> = {
  decision: 'decisions',
  gotcha: 'gotchas',
  convention: 'conventions',
  runbook: 'runbooks',
  service: 'services',
  concept: 'concepts',
};

/**
 * Bundle-root relative Markdown filename of a concept page: `<type-dir>/<path>.md`.
 * The concept `path` is validated against the frozen path syntax — a page's
 * location is derived only from contract-safe segments.
 */
export function okfConceptRelPath(type: ConceptType, path: string): string {
  const dir = OKF_TYPE_DIR_MAP[type];
  const parsed = conceptPath.parse(path);
  return `${dir}/${parsed}.md`;
}

// ── Per-concept frontmatter (rule: UUID must be preserved, N5) ─────────────
/**
 * The YAML frontmatter of a concept page. It carries every `concept` DTO field
 * except `body` (the page content after the frontmatter) and `evidenceCount`
 * (a read-time display projection, not part of the OKF archive format — the
 * DUA-234 change note states exactly this). `uuid` is the canonical identity
 * and is always present so an import can re-establish teamem identity even if
 * the page is later moved or renamed.
 */
export const okfConceptFrontmatter = z.strictObject({
  // OKF mandates `type`; the remaining keys are teamem's profile.
  type: conceptType,
  uuid: conceptUuid,
  path: conceptPath,
  status: conceptStatus,
  confidence,
  title: z.string().min(1),
  tags: z.array(z.string()),
  // UTC `Z`, fixed millisecond-precision ISO 8601 (N8).
  lastConfirmed: isoDateTime,
  firstSeen: isoDateTime,
  createdAt: isoDateTime,
  // N8: the concept schema version doubles as the OKF format version.
  schemaVersion: z.literal(CONCEPT_SCHEMA_VERSION),
  supersedes: conceptUuid.nullable(),
  aliases: z.array(conceptPath),
  contributors: z.array(principalRef),
  evidence: z.array(evidence).min(1), // red line: every page carries evidence
});
export type OkfConceptFrontmatter = z.infer<typeof okfConceptFrontmatter>;

/** Serialize the frontmatter of a concept page as a fenced YAML block. */
export function renderConceptFrontmatter(concept: Concept): string {
  const fm = okfConceptFrontmatter.parse({
    type: concept.type,
    uuid: concept.uuid,
    path: concept.path,
    status: concept.status,
    confidence: concept.confidence,
    title: concept.title,
    tags: concept.tags,
    lastConfirmed: concept.lastConfirmed,
    firstSeen: concept.firstSeen,
    createdAt: concept.createdAt,
    schemaVersion: concept.schemaVersion,
    supersedes: concept.supersedes,
    aliases: concept.aliases,
    contributors: concept.contributors,
    evidence: concept.evidence,
  });
  // lineWidth: 0 disables wrapping so evidence URLs and titles stay on one
  // line — deterministic and diff-friendly output.
  return `---\n${stringify(fm, { lineWidth: 0 })}---\n`;
}

// ── Page splitting / parsing (round-trip and future import) ────────────────
/**
 * Split a page into its leading frontmatter YAML block (OKF F001: every
 * non-reserved Markdown file begins with a `---` delimited block) and the
 * remaining body. Returns null when the file does not start with the block.
 */
export function splitOkfPage(
  text: string,
): { yamlText: string; body: string } | null {
  if (!text.startsWith('---\n')) return null;
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      return {
        yamlText: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }
  return null;
}

/**
 * Parse a page against a frontmatter schema. Returns null for a missing
 * frontmatter block, unparsable YAML, or schema mismatch — never throws. The
 * body is returned verbatim so importers can resolve relative links back to
 * `teamem://concept/<uuid>` via the page map.
 */
export function parseOkfPage<T extends z.ZodType>(
  schema: T,
  text: string,
): { data: z.infer<T>; body: string } | null {
  const split = splitOkfPage(text);
  if (!split) return null;
  let parsed: unknown;
  try {
    parsed = parse(split.yamlText);
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) return null;
  return { data: result.data, body: split.body };
}

/** Parse and validate a concept page (frontmatter + body). */
export function parseConceptPage(
  text: string,
): { data: OkfConceptFrontmatter; body: string } | null {
  return parseOkfPage(okfConceptFrontmatter, text);
}

// ── teamem://concept/<uuid> → relative Markdown link resolution ────────────
/**
 * Global scanner for in-body teamem links. It is the unanchored, capturing
 * form of the frozen `conceptLinkPattern` from concept.ts, which validates a
 * single complete URI; the contract test pins the two in lockstep. The
 * capture group is the bare UUID so the resolver can look it up in the
 * bundle map.
 */
const TEAMEM_LINK_GLOBAL = new RegExp(
  `teamem://concept/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`,
  'g',
);

/** Collect every `teamem://concept/<uuid>` URI referenced in a body. */
export function extractTeamemLinks(body: string): string[] {
  const links: string[] = [];
  for (const match of body.matchAll(TEAMEM_LINK_GLOBAL)) {
    links.push(match[0]);
  }
  return links;
}

/** Extract the UUID from a canonical teamem link URI. */
export function teamemLinkUuid(uri: string): string | null {
  if (!conceptLinkPattern.test(uri)) return null;
  return uri.slice('teamem://concept/'.length);
}

/**
 * Relative Markdown path from one bundle file to another. Both paths use the
 * frozen concept-path segment syntax (`[a-z0-9-]+` joined by `/`, plus the
 * `.md` suffix), which never contains characters requiring percent-encoding.
 * From the bundle root (`index.md`, `log.md`) the target link is prefixed
 * with `./`; from a page in a type directory it is prefixed with one `../`
 * per source directory level.
 */
export function relativeMarkdownLink(
  fromRelFile: string,
  toRelFile: string,
): string {
  const index = fromRelFile.lastIndexOf('/');
  if (index === -1) return `./${toRelFile}`; // source is at the bundle root
  const fromDir = fromRelFile.slice(0, index);
  const depth = fromDir.split('/').length;
  return `${'../'.repeat(depth)}${toRelFile}`;
}

/**
 * Replace every `teamem://concept/<uuid>` in a body with a relative Markdown
 * path computed against the source file's position in the bundle. Resolved
 * links point at the concept's exported page; the UUID remains recoverable
 * from that page's frontmatter. Unresolved UUIDs keep the canonical URI
 * untouched — the link stays honest and round-trip recoverable.
 */
export function resolveTeamemLinks(
  body: string,
  sourceRelPath: string,
  uuidToBundlePath: ReadonlyMap<string, string>,
): string {
  return body.replace(TEAMEM_LINK_GLOBAL, (whole, uuid: string) => {
    const bundleRel = uuidToBundlePath.get(uuid);
    if (bundleRel === undefined) return whole;
    return relativeMarkdownLink(sourceRelPath, bundleRel);
  });
}

/** Render a complete concept page: frontmatter + link-resolved body. */
export function renderConceptPage(
  concept: Concept,
  options: {
    sourceRelPath: string;
    uuidToBundlePath: ReadonlyMap<string, string>;
  },
): string {
  const frontmatter = renderConceptFrontmatter(concept);
  const body = resolveTeamemLinks(
    concept.body,
    options.sourceRelPath,
    options.uuidToBundlePath,
  );
  return `${frontmatter}${body}\n`;
}

// ── Reserved files: index.md catalog and log.md change log ─────────────────
/** One concept page as it appears in the reserved catalog files. */
export const okfBundleEntry = z.strictObject({
  type: conceptType,
  uuid: conceptUuid,
  title: z.string().min(1),
  /** Bundle-root relative exported path, e.g. 'decisions/mysql.md'. */
  relPath: z.string().min(1),
  /** ISO timestamp of the entry's freshest confirmation (Q10 semantics). */
  lastConfirmed: isoDateTime,
});
export type OkfBundleEntry = z.infer<typeof okfBundleEntry>;

/** Derive the catalog entry for a concept page. */
export function okfBundleEntryFromConcept(concept: Concept): OkfBundleEntry {
  return okfBundleEntry.parse({
    type: concept.type,
    uuid: concept.uuid,
    title: concept.title,
    relPath: okfConceptRelPath(concept.type, concept.path),
    lastConfirmed: concept.lastConfirmed,
  });
}

function sortBundleEntries(entries: OkfBundleEntry[]): OkfBundleEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.lastConfirmed.localeCompare(a.lastConfirmed) || // freshness desc
      a.uuid.localeCompare(b.uuid), // deterministic tie-break (Q10 ordering)
  );
}

/** Escape title text for a Markdown link label. */
export function escapeMarkdownLinkText(title: string): string {
  return title.replace(/[[\]]/g, (c) => `\\${c}`);
}

/**
 * Render the reserved `index.md` catalog: one section per concept type (in
 * the frozen dir order), each listing every page with its relative Markdown
 * link, newest confirmation first. Deterministic within a given entry set.
 */
export function renderBundleIndex(entries: OkfBundleEntry[]): string {
  const sorted = sortBundleEntries(entries);
  const sections: string[] = [];
  for (const dir of OKF_TYPE_DIRS) {
    const group = sorted.filter((e) => e.relPath.startsWith(`${dir}/`));
    if (group.length === 0) continue;
    const lines = group.map(
      (e) =>
        `- [${escapeMarkdownLinkText(e.title)}](${relativeMarkdownLink(
          OKF_BUNDLE_INDEX_FILE,
          e.relPath,
        )})`,
    );
    sections.push(`## ${dir}\n\n${lines.join('\n')}`);
  }
  return `${renderOkfReservedFrontmatter()}# Teamem OKF bundle\n\n${sections.join('\n\n')}\n`;
}

/**
 * Render the reserved `log.md` change log: one item per concept page, newest
 * `lastConfirmed` first with the same deterministic tie-break as the catalog.
 */
export function renderBundleLog(entries: OkfBundleEntry[]): string {
  const sorted = sortBundleEntries(entries);
  const lines = sorted.map(
    (e) => `- ${e.lastConfirmed} ${e.relPath} (${e.uuid}) — ${e.title}`,
  );
  return `${renderOkfReservedFrontmatter()}# Change log\n\n${lines.join('\n')}\n`;
}