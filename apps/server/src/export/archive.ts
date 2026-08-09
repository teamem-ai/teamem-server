/**
 * OKF bundle archive writer (DUA-251 / M3-EXPORT-04).
 *
 * Packages the rendered OKF bundle file tree into a deterministic
 * `.tar.gz` archive using only Node built-ins:
 *
 *   - A hand-rolled ustar writer (no third-party dependency) emits one
 *     regular file entry per bundle file, preserving the renderer's
 *     deterministic order — the archive is a deterministic function of the
 *     bundle file list, byte-identical across renders of the same project
 *     state (fixed mtime, uid, gid, mode; gzip MTIME header zeroed by
 *     Node's zlib).
 *   - Paths that do not fit the ustar `name` field (99 chars + NUL) are
 *     emitted with the GNU/bsdtar-compatible "longname" entry (typeflag
 *     `L`): the full path travels in the entry data, so `tar xf` on every
 *     mainstream implementation (GNU tar, bsdtar on macOS/Windows,
 *     busybox) restores the exact tree a future import endpoint
 *     (`M3-EXPORT-05`, SaaS backlog) can read back.
 *   - __Path safety.__ Every relPath is validated before encoding: no
 *     empty segments, `.` / `..` segments, leading `/`, trailing `/`,
 *     backslashes, NUL bytes, or absolute-escape attempts. A bundle file
 *     that cannot be represented is a hard failure
 *     ({@link ArchiveError}) — the writer never silently drops, renames,
 *     or truncates a file. Bundle relPaths are already derived from the
 *     frozen concept-path syntax by the renderer, so this gate is defense
 *     in depth against raw-SQL corruption, not a routine branch.
 *   - __No content leakage.__ The archive contains ONLY rendered bundle
 *     files (already-redacted, persisted knowledge pages) — no raw
 *     payloads, query text, credentials, or request state. Errors thrown
 *     here never include file content.
 */
import { gzipSync } from 'node:zlib';

// ── Constants ───────────────────────────────────────────────────────────────

/** ustar block size. */
const TAR_BLOCK = 512;
/** Deterministic fixed mtime — 1970-01-01T00:00:00Z, never "now". */
const TAR_MTIME = 0;
/** Regular files are world-readable; archive bit set. */
const TAR_MODE = 0o644;
/**
 * Hard safety cap for an entry path. The frozen concept-path contract caps
 * paths at 200 chars, so real bundles stay far below this; the cap exists
 * only to bound memory for the longname data field against corruption.
 */
const MAX_ENTRY_PATH_BYTES = 4096;

// ── Types and errors ────────────────────────────────────────────────────────

/** One file of the bundle: bundle-root relative path + UTF-8 content. */
export interface ArchiveSourceFile {
  readonly relPath: string;
  readonly content: string;
}

/**
 * Thrown when the bundle cannot be packaged as a valid tar tree — an
 * unsafe (or unrepresentable) relPath. The writer never silently resolves
 * such a file by dropping or renaming it.
 */
export class ArchiveError extends Error {
  readonly name = 'ArchiveError';
}

// ── Field writers ───────────────────────────────────────────────────────────

/**
 * Write a NUL-terminated ASCII string field, truncating to the field width.
 * ASCII-only per ustar; non-ASCII bytes in a name are a contract violation
 * upstream of this writer (paths match `[a-z0-9-]`).
 */
function writeField(
  block: Uint8Array,
  offset: number,
  width: number,
  value: string,
): void {
  const bytes = Buffer.from(value, 'ascii').subarray(0, Math.max(0, width - 1));
  block.set(bytes, offset);
  block[offset + bytes.length] = 0; // terminator (also when bytes.length === 0)
}

/** Format a value as a NUL-terminated octal field (minimum width, no sign). */
function writeOctal(
  block: Uint8Array,
  offset: number,
  width: number,
  value: number,
): void {
  const digits = Math.max(1, width - 1);
  const text = value
    .toString(8)
    .padStart(digits, '0')
    .slice(-digits)
    .padEnd(digits, '0');
  writeField(block, offset, width, text);
}

/**
 * Build one 512-byte ustar header block.
 *
 * `prefix` (the ustar path-prefix field) is left empty: long paths are
 * handled with GNU-style longname entries instead, which are unambiguous
 * for any length and understood by every mainstream tar implementation.
 */
function buildHeader(entry: {
  name: string;
  size: number;
  typeflag: '0' | 'L';
}): Buffer {
  const block = Buffer.alloc(TAR_BLOCK);

  writeField(block, 0, 100, entry.name); // name
  writeOctal(block, 100, 8, TAR_MODE); // mode
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, entry.size); // size (octal)
  writeOctal(block, 136, 12, TAR_MTIME); // mtime (octal)
  // chksum (148..155): computed after the rest of the header is filled;
  // the checksum field itself is 8 ASCII spaces during computation.
  block[156] = entry.typeflag.charCodeAt(0); // typeflag
  // linkname (157..256) — zeros
  writeField(block, 257, 6, 'ustar'); // magic
  writeField(block, 263, 2, '00'); // version
  writeField(block, 265, 32, 'teamem'); // uname
  writeField(block, 297, 32, 'teamem'); // gname
  // devmajor (329..335), devminor (337..343), prefix (345..499) — zeros

  // Checksum: unsigned sum of all header bytes with the checksum field
  // as ASCII spaces; stored as 6-digit octal, NUL, space.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  const checksum = sum.toString(8).padStart(6, '0') + '\0 ';
  block.set(Buffer.from(checksum, 'ascii'), 148);

  return block;
}

// ── Path validation ─────────────────────────────────────────────────────────

/**
 * Validate a bundle-relative path before encoding. Rejects anything that
 * could escape the bundle root or confuse a tar reader:
 *   - empty / `.` / `..` segments,
 *   - leading or trailing `/`,
 *   - backslashes (Windows path separators) and NUL bytes,
 *   - paths longer than the sanity cap.
 */
function assertSafeRelPath(relPath: string): void {
  if (relPath.length === 0) {
    throw new ArchiveError('refusing to archive an empty relPath');
  }
  if (relPath.length > MAX_ENTRY_PATH_BYTES) {
    throw new ArchiveError(`relPath exceeds ${MAX_ENTRY_PATH_BYTES} bytes: "${relPath}"`);
  }
  if (relPath.startsWith('/') || relPath.endsWith('/')) {
    throw new ArchiveError(`relPath must be bundle-root relative (no leading/trailing /): "${relPath}"`);
  }
  if (relPath.includes('\\') || relPath.includes('\0')) {
    throw new ArchiveError(`relPath contains unsafe characters: "${relPath}"`);
  }
  for (const segment of relPath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ArchiveError(`relPath contains an unsafe segment: "${relPath}"`);
    }
  }
}

// ── Writer ─────────────────────────────────────────────────────────────────

/**
 * Build a ustar tar archive from an ordered list of bundle files.
 *
 * Input order is preserved exactly (the renderer already emits the frozen
 * deterministic order: reserved files first, then per-type directories).
 * Every file whose name does not fit the 99-char (plus NUL) ustar name
 * field is preceded by a GNU-style longname entry carrying the full path.
 *
 * Throws {@link ArchiveError} for any unsafe or unrepresentable relPath.
 */
export function buildOkfTar(files: readonly ArchiveSourceFile[]): Buffer {
  const blocks: Buffer[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const relPath = file.relPath;
    assertSafeRelPath(relPath);

    // Two entries under the same relPath would silently collide in tar
    // (later entry wins on extraction). The renderer already guarantees a
    // collision-free tree; this is a data-integrity backstop that fails
    // loudly instead of silently dropping a page.
    if (seen.has(relPath)) {
      throw new ArchiveError(
        `duplicate bundle path "${relPath}" — refusing to emit a colliding archive`,
      );
    }
    seen.add(relPath);

    const content = Buffer.from(file.content, 'utf8');
    const nameBytes = Buffer.byteLength(relPath, 'utf8');

    // ustar's name field holds at most 99 chars + NUL: anything 100 bytes
    // or longer cannot be NUL-terminated in-field, so emit a longname
    // entry (GNU/bsdtar compatible) to preserve the path exactly. Without
    // this, a 100-byte path would silently lose its final byte.
    if (nameBytes > 99) {
      // Longname entry: full path in the data block, reader replaces the
      // truncated name field of the following entry with this value.
      const longNameData = Buffer.concat([
        Buffer.from(relPath, 'utf8'),
        Buffer.from([0]),
      ]);
      blocks.push(buildHeader({ name: relPath.slice(0, 100), size: longNameData.length, typeflag: 'L' }));
      const paddedData = Buffer.alloc(
        Math.ceil(longNameData.length / TAR_BLOCK) * TAR_BLOCK,
      );
      longNameData.copy(paddedData, 0);
      blocks.push(paddedData);
    }

    blocks.push(buildHeader({ name: relPath.slice(0, 100), size: content.length, typeflag: '0' }));
    const paddedContent = Buffer.alloc(
      Math.ceil(content.length / TAR_BLOCK) * TAR_BLOCK,
    );
    content.copy(paddedContent, 0);
    blocks.push(paddedContent);
  }

  // End-of-archive: two zero blocks.
  blocks.push(Buffer.alloc(TAR_BLOCK), Buffer.alloc(TAR_BLOCK));

  return Buffer.concat(blocks);
}

/**
 * Build the deterministic `.tar.gz` OKF bundle from the renderer's file
 * tree. Preserves the renderer's file order; gzip is size-compressed with
 * Node's deterministic zlib (MTIME header zeroed).
 */
export function buildOkfTarGz(files: readonly ArchiveSourceFile[]): Buffer {
  return gzipSync(buildOkfTar(files), { level: 9 });
}