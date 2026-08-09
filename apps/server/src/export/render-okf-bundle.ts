/**
 * M3 OKF bundle renderer service (DUA-250 / M3-EXPORT-03).
 *
 * Renders the scoped whole-project export into the OKF bundle file tree:
 *
 *   index.md                  catalog (reserved, always present)
 *   log.md                    change log (reserved, always present)
 *   decisions/<path>.md
 *   gotchas/<path>.md
 *   conventions/<path>.md
 *   runbooks/<path>.md
 *   services/<path>.md
 *   concepts/<path>.md        one page per concept, frontmatter + body
 *
 * The service composes the two frozen layers already in the tree:
 *   1. `exportProject` (M3-EXPORT-02) — the ONLY way into the data. It
 *      enforces the tagged ScopeContext (red line 5.5), returns pages
 *      bounded by a hard cap, and never emits a schema-invalid concept: such
 *      concepts arrive in `skipped` with their UUID and reason.
 *   2. The pure OKF contract functions in `@teamem/schema` (M3-EXPORT-01) —
 *      `renderConceptPage`, `renderBundleIndex`, `renderBundleLog`,
 *      `okfConceptRelPath` — which perform all rendering and the
 *      `teamem://concept/<uuid>` → relative Markdown link rewrite.
 *
 * Deterministic output (round-trip / diff): the bundle is a pure function
 * of the SET of concepts read. File order never depends on pagination or
 * creation order — `index.md` and `log.md` come first (reserved files),
 * then the six per-type directories in the frozen `OKF_TYPE_DIRS` order,
 * and within each directory the pages are sorted by their bundle-relative
 * path (byte order). The catalog and change log are sorted by the contract's
 * own deterministic order (`lastConfirmed` desc + uuid tie-break). Given
 * the same project state, two renders are byte-identical, and the render
 * with a page limit of 1 produces the same bundle as one with the default
 * limit (tests pin both).
 *
 * Red lines honored:
 * - __Explicit scope only (5.5).__ The renderer walks pages through
 *   `exportProject`, which derives `teamId` exclusively from the passed
 *   `ScopeContext`. There is no unscoped entry point here. A missing or
 *   cross-team project returns null — identical to the repository's answer,
 *   so upstream can keep the single 404 behavior (anti-enumeration).
 * - __No fake pages (5.1).__ A concept the repository cannot assemble into
 *   a valid `Concept` is surfaced in `skipped`, never rendered as a page.
 *   Links that point at a skipped (or otherwise unresolvable) UUID keep the
 *   canonical `teamem://concept/<uuid>` URI untouched — the bundle stays
 *   honest and round-trip recoverable.
 * - __Deterministic, collision-free tree.__ Every emitted relPath derives
 *   from the frozen path syntax via `okfConceptRelPath`; the per-project
 *   `concept_paths` namespace guarantees two concepts can never share a
 *   current path. As a data-integrity backstop the renderer still refuses
 *   to emit two files under the same relPath: if a raw-SQL corruption ever
 *   produced a duplicate, it throws {@link RenderOkfBundleError} instead of
 *   silently overwriting one page with another.
 * - __Read-only.__ No writes, no side effects; only already-redacted,
 *   persisted data is read (the redaction pass ran before persistence).
 * - __Bounded reads.__ Pages are consumed one at a time and dropped after
 *   use; only the assembled page bodies and the (uuid → relPath) map live
 *   across pages. The bundle itself is unavoidably O(project), because a
 *   whole-project export IS the whole project.
 */
import {
  OKF_BUNDLE_INDEX_FILE,
  OKF_BUNDLE_LOG_FILE,
  OKF_TYPE_DIRS,
  okfBundleEntryFromConcept,
  okfConceptRelPath,
  renderBundleIndex,
  renderBundleLog,
  renderConceptPage,
} from '@teamem/schema';
import type { Concept } from '@teamem/schema';
import type { AppDb } from '../db/client.js';
import {
  exportProject,
  type SkippedConcept,
} from '../db/repositories/export.js';
import type { ScopeContext } from '../auth/scope.js';

// ── Return types ────────────────────────────────────────────────────────────

/** One file of the rendered bundle: bundle-root relative path + content. */
export interface OkfBundleFile {
  /** Bundle-root relative path, e.g. 'index.md' or 'services/auth-api.md'. */
  readonly relPath: string;
  /** Rendered UTF-8 file content. */
  readonly content: string;
}

/**
 * The rendered OKF bundle. `files` IS the bundle file tree: `index.md` and
 * `log.md` first, then one page per concept grouped under its type
 * directory, in the frozen directory order, pages sorted byte-wise by path.
 * `renderedConcepts + skipped.length` equals `totalConcepts` unless the
 * project changed while the pages were being walked (concurrent writes);
 * counts are reported honestly so the caller can detect that drift.
 */
export interface RenderOkfBundleResult {
  readonly project: { readonly id: string; readonly name: string };
  /** OKF concept format version (N8) — how to interpret every Concept page. */
  readonly schemaVersion: number;
  /** Number of concepts in the project when the repository counted them. */
  readonly totalConcepts: number;
  /** Concept pages actually emitted into the bundle. */
  readonly renderedConcepts: number;
  /** Concepts the repository could not assemble, with reasons — never pages. */
  readonly skipped: readonly SkippedConcept[];
  /** Deterministic ordered file tree. */
  readonly files: readonly OkfBundleFile[];
}

export interface RenderOkfBundleOptions {
  /**
   * Project to export. Required when `scope.kind === 'allProjects'`; must
   * be omitted (or identical) when the scope is already project-scoped.
   * Same contract as the repository — a conflicting value throws
   * {@link ExportScopeInvalidError} upstream.
   */
  readonly projectId?: string;
  /**
   * Repository page size used while walking the project. Must be an integer
   * in [1, repository max]; invalid values throw the repository's
   * {@link ExportLimitInvalidError}. Given the same data, the rendered
   * bundle is identical for every page size.
   */
  readonly pageLimit?: number;
}

/**
 * Thrown when the bundle cannot be rendered as a valid file tree — today
 * only when two concepts would map to the same bundle-relative path (an
 * impossible state under the per-project path namespace, only reachable via
 * raw-SQL corruption). The renderer never silently resolves such a
 * collision by overwriting one page with another.
 */
export class RenderOkfBundleError extends Error {
  readonly name = 'RenderOkfBundleError';
}

// ── Public API (the ONLY entry point; scoped by ScopeContext) ───────────────

/**
 * Render the scoped project's whole compiled knowledge as an OKF bundle.
 *
 * Walks every page of the scoped export via the repository cursor (never
 * issuing a project-wide read itself), builds the uuid → relPath map,
 * renders each concept page with its in-body `teamem://` links rewritten to
 * relative Markdown paths, and renders the reserved `index.md` catalog and
 * `log.md` change log. Returns the deterministic file tree.
 *
 * Returns `null` when the project does not exist OR does not belong to the
 * scope's team — upstream must respond identically for both. Throws the
 * repository's ExportCursorInvalidError never (no external cursor),
 * ExportLimitInvalidError/ExportScopeInvalidError for
 * invalid options, and {@link RenderOkfBundleError} for the duplicate-path
 * impossibility.
 */
export async function renderOkfBundle(
  db: AppDb,
  scope: ScopeContext,
  options: RenderOkfBundleOptions = {},
): Promise<RenderOkfBundleResult | null> {
  // 1. Walk every page — one bounded read at a time; earlier pages' raw
  //    DTOs are discarded as soon as they are appended.
  let cursor: string | undefined;
  let project: { id: string; name: string } | undefined;
  let schemaVersion = 0;
  let totalConcepts = 0;
  const concepts: Concept[] = [];
  const skipped: SkippedConcept[] = [];
  do {
    const page = await exportProject(db, scope, {
      projectId: options.projectId,
      limit: options.pageLimit,
      cursor,
    });
    if (page === null) return null; // missing OR another team's project — identical
    project = page.project;
    schemaVersion = page.schemaVersion;
    totalConcepts = page.totalConcepts;
    concepts.push(...page.concepts);
    skipped.push(...page.skipped);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  // 2. uuid → bundle-rel-path map (the link-resolution table) + collision
  //    backstop: two concepts can never share a relPath, but if raw-SQL
  //    corruption ever produced a duplicate, fail loudly rather than
  //    silently overwriting one page with another.
  const uuidToBundlePath = new Map<string, string>();
  const relPathOwner = new Map<string, string>();
  for (const concept of concepts) {
    const relPath = okfConceptRelPath(concept.type, concept.path);
    const previous = relPathOwner.get(relPath);
    if (previous !== undefined) {
      throw new RenderOkfBundleError(
        `concepts ${previous} and ${concept.uuid} both map to bundle path "${relPath}" — refusing to render a corrupted file tree`,
      );
    }
    relPathOwner.set(relPath, concept.uuid);
    uuidToBundlePath.set(concept.uuid, relPath);
  }

  // 3. Render one page per concept (frontmatter + link-resolved body) and
  //    collect the catalog/log entries in the same pass.
  const conceptPages: OkfBundleFile[] = [];
  const entries = concepts.map(okfBundleEntryFromConcept);
  for (const concept of concepts) {
    const relPath = uuidToBundlePath.get(concept.uuid)!;
    conceptPages.push({
      relPath,
      content: renderConceptPage(concept, {
        sourceRelPath: relPath,
        uuidToBundlePath,
      }),
    });
  }

  // 4. Assemble the deterministic tree: reserved files, then the six type
  //    directories in frozen order, pages byte-sorted within each directory.
  const files: OkfBundleFile[] = [
    {
      relPath: OKF_BUNDLE_INDEX_FILE,
      content: renderBundleIndex(entries),
    },
    {
      relPath: OKF_BUNDLE_LOG_FILE,
      content: renderBundleLog(entries),
    },
  ];
  for (const dir of OKF_TYPE_DIRS) {
    const pagesInDir = conceptPages
      .filter((f) => f.relPath.startsWith(`${dir}/`))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    files.push(...pagesInDir);
  }

  return {
    project: project!,
    schemaVersion,
    totalConcepts,
    renderedConcepts: conceptPages.length,
    skipped,
    files,
  };
}