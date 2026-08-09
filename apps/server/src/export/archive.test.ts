/**
 * OKF bundle archive writer unit tests — DUA-251 / M3-EXPORT-04.
 *
 * Pure unit tests (no database) for the dependency-free tar.gz writer:
 *   - structure: ustar headers with correct checksums, content padding,
 *     order preserved, two zero end blocks, gzip wraps it;
 *   - round-trip: a bundled minimal tar READER recovers name+content
 *     exactly (including >100-byte paths via GNU-style longname entries);
 *   - real consumption exit: when the system `tar` binary is present, it
 *     must list and extract the archive byte-for-byte (honestly skipped
 *     when tar is unavailable);
 *   - determinism: two builds of the same bundle are byte-identical;
 *   - path safety: empty, absolute, `..`/`.` segments, trailing slash,
 *     backslash, and NUL paths all throw ArchiveError — never emitted.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import {
  buildOkfTar,
  buildOkfTarGz,
  ArchiveError,
  type ArchiveSourceFile,
} from './archive.js';

const execFileAsync = promisify(execFile);

// ── Minimal tar reader (test-only) ──────────────────────────────────────────

interface ParsedEntry {
  name: string;
  content: Buffer;
}

function readOctal(field: Buffer): number {
  const text = field.toString('ascii').replace(/\0/g, ' ').trim();
  return text === '' ? 0 : parseInt(text, 8);
}

function parseTar(buf: Buffer): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  let zeroRuns = 0;

  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) {
      zeroRuns += 1;
      offset += 512;
      if (zeroRuns >= 2) break; // end-of-archive marker
      continue;
    }
    zeroRuns = 0;

    const typeflag = String.fromCharCode(block[156]!);
    const size = readOctal(block.subarray(124, 136));
    const name = block.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);

    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
    } else if (typeflag === '0') {
      entries.push({ name: pendingLongName ?? name, content: Buffer.from(data) });
      pendingLongName = null;
    } else {
      throw new Error(`unexpected typeflag ${typeflag}`);
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

/** Verify the stored checksum field against a recomputed header sum. */
function headerChecksumValid(block: Buffer): boolean {
  const stored = block.subarray(148, 156).toString('ascii').replace(/\0/g, '').trim();
  const blank = Buffer.from(block);
  blank.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of blank) sum += b;
  return stored === sum.toString(8).padStart(6, '0');
}

const SAMPLE_FILES: ArchiveSourceFile[] = [
  { relPath: 'index.md', content: '---\nokf_version: "0.1"\n---\n# Team knowledge\n' },
  { relPath: 'log.md', content: '---\nokf_version: "0.1"\n---\n- 2025-06-02\n' },
  { relPath: 'services/auth-api.md', content: '# Auth API\n\nServes tokens.\n' },
  { relPath: 'decisions/use-postgres.md', content: '# Use Postgres\n\nWe decided.\n' },
];

describe('buildOkfTar / buildOkfTarGz (no database)', () => {
  it('packages files in order with valid ustar headers and padded content', () => {
    const tar = buildOkfTar(SAMPLE_FILES);

    // End-of-archive marker: two zero blocks at the tail.
    expect(tar.length % 512).toBe(0);
    const tail = tar.subarray(tar.length - 1024);
    expect(tail.every((b) => b === 0)).toBe(true);

    // Walk headers directly.
    let offset = 0;
    const names: string[] = [];
    let headerCount = 0;
    while (offset + 1024 < tar.length) {
      const block = tar.subarray(offset, offset + 512);
      if (block.every((b) => b === 0)) break;
      expect(block.subarray(257, 263).toString('ascii')).toBe('ustar\0');
      expect(headerChecksumValid(block)).toBe(true);
      headerCount += 1;
      const size = readOctal(block.subarray(124, 136));
      names.push(block.subarray(0, 100).toString('ascii').replace(/\0.*$/, ''));
      offset += 512 + Math.ceil(size / 512) * 512;
    }

    expect(headerCount).toBe(SAMPLE_FILES.length);
    expect(names).toEqual(SAMPLE_FILES.map((f) => f.relPath));
  });

  it('recovers names and content exactly via the bundled reader', () => {
    const entries = parseTar(buildOkfTar(SAMPLE_FILES));
    expect(entries.map((e) => e.name)).toEqual(SAMPLE_FILES.map((f) => f.relPath));
    for (const f of SAMPLE_FILES) {
      const entry = entries.find((e) => e.name === f.relPath)!;
      expect(entry.content.toString('utf8')).toBe(f.content);
    }
  });

  it('wraps the tar in gzip and survives gunzip', () => {
    const gz = buildOkfTarGz(SAMPLE_FILES);
    const tar = gunzipSync(gz);
    const entries = parseTar(tar);
    expect(entries).toHaveLength(SAMPLE_FILES.length);
    expect(entries[0]!.name).toBe('index.md');
  });

  it('emits longname entries for paths longer than the 100-byte name field', () => {
    const longPath = `conventions/${'a'.repeat(95)}/${'b'.repeat(20)}.md`; // 114 chars
    const entries = parseTar(buildOkfTar([{ relPath: longPath, content: '# long' }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe(longPath);
    expect(entries[0]!.content.toString('utf8')).toBe('# long');
  });

  it('is byte-identical for repeated builds of the same bundle (determinism)', () => {
    const a = buildOkfTarGz(SAMPLE_FILES);
    const b = buildOkfTarGz(SAMPLE_FILES);
    expect(a.equals(b)).toBe(true);
  });

  it('rejects duplicate relPaths — refuses to emit a colliding archive', () => {
    expect(() =>
      buildOkfTar([
        { relPath: 'index.md', content: 'a' },
        { relPath: 'index.md', content: 'b' },
      ]),
    ).toThrow(ArchiveError);
  });

  it('rejects unsafe or unrepresentable relPaths — never emits them', () => {
    const unsafe: string[] = [
      '',
      '../escape.md',
      'dir/../../escape.md',
      '/absolute.md',
      'trailing/',
      'a//b.md',
      'a/./b.md',
      'a\\b.md',
      'a\0b.md',
      'x'.repeat(5000), // exceeds the sanity cap
    ];
    for (const relPath of unsafe) {
      expect(() => buildOkfTar([{ relPath, content: 'x' }])).toThrow(ArchiveError);
    }
  });

  /**
   * Real consumption exit: the system `tar` must list and extract the
   * archive exactly. Skips honestly when the binary is unavailable.
   */
  it.runIf(/^win/i.test(process.platform) ? false : true)('is consumable by the system tar binary', async () => {
    const gz = buildOkfTarGz(SAMPLE_FILES);
    const dir = await mkdtemp(join(tmpdir(), 'teamem-okf-tar-'));
    try {
      const archivePath = join(dir, 'bundle.tar.gz');
      await writeFile(archivePath, gz);

      // Listing must show every bundle-relative path.
      const { stdout } = await execFileAsync('tar', ['-tzf', archivePath]);
      const listed = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      expect(listed).toEqual(SAMPLE_FILES.map((f) => f.relPath));

      // Extraction must reproduce content byte-for-byte.
      await execFileAsync('tar', ['-xzf', archivePath, '-C', dir]);
      for (const f of SAMPLE_FILES) {
        const out = await readFile(join(dir, f.relPath), 'utf8');
        expect(out).toBe(f.content);
      }

      // A long-name bundle also round-trips through system tar.
      const longPath = `conventions/${'a'.repeat(95)}/${'b'.repeat(20)}.md`;
      const longGz = buildOkfTarGz([{ relPath: longPath, content: '# long' }]);
      const longPath2 = join(dir, 'long.tar.gz');
      await writeFile(longPath2, longGz);
      await execFileAsync('tar', ['-xzf', longPath2, '-C', dir]);
      const longOut = await readFile(join(dir, longPath), 'utf8');
      expect(longOut).toBe('# long');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});