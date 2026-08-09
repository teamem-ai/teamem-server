/**
 * Recursively list files under a directory (no symlinks, no node_modules).
 * Returns paths relative to the repository root, e.g. "packages/schema/src/index.ts".
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
  return out;
}