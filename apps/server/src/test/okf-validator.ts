/**
 * Test-only access to the REAL okf-skills validator (DUA-253 / M3-EXPORT-06).
 *
 * "okf-skills" is the Open Knowledge Format toolkit for Claude Code
 * (https://github.com/scaccogatto/okf-skills, MIT). Its deterministic
 * conformance checker `skills/validate/scripts/okf_validate.py` is the real
 * validator this suite runs exported bundles through — never a local
 * re-implementation or a stub.
 *
 * This module obtains that exact script pinned to ONE immutable upstream
 * commit (never a moving branch) and resolves a Python runtime for it, so
 * runs are reproducible and tamper-evident. Availability is reported through
 * a single `ready` flag: when the validator cannot be obtained or run
 * (no network, no uv, no python3, no pyyaml) the caller must SKIP its tests
 * and say so — a skip is explicitly NOT a pass (AGENTS.md §11 "honest
 * reporting"; ticket DUA-253 "honest skip when validator unavailable
 * (skip ≠ pass)").
 *
 * Resolution order (all overridable via TEAMEM_-prefixed env, AGENTS.md §4):
 *   1. TEAMEM_OKF_VALIDATOR_SCRIPT — path to a local pinned copy of the
 *      script (offline CI/dev; lets an operator snapshot upstream). The
 *      file's SHA-256 must match the pinned digest.
 *   2. TEAMEM_OKF_VALIDATOR_URL     — URL to fetch (defaults to the pinned
 *      raw.githubusercontent.com URL below); SHA-256 verified on download.
 *   3. Runtime, TEAMEM_OKF_VALIDATOR_RUNTIME — 'uv' | 'python3' | absolute
 *      python path. Auto-detect prefers `uv run --script` (uv self-provisions
 *      pyyaml from the script's PEP 723 metadata), else `python3` when
 *      pyyaml is importable.
 *
 * The validator runs in default conformance mode (no --strict): OKF v0.2's
 * soft guidance is reported as warnings, and the hard §11 rule set — the
 * conformance gate teamem's v0.1 profile targets — decides pass/fail.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Pinned upstream source ─────────────────────────────────────────────────
/**
 * Immutable upstream commit of scaccogatto/okf-skills the validator script is
 * fetched at. The integration test pins this exact revision so results are
 * reproducible and the fetched file is always the "real" validator.
 */
export const OKF_SKILLS_VALIDATOR_COMMIT =
  'b33329bf87b594117833997fbeca48daa7b26e40' as const;

/** SHA-256 of okf_validate.py at the pinned commit (verified on acquire). */
export const OKF_SKILLS_VALIDATOR_SHA256 =
  'a82deba515458f4bcf48be413f3107b4bb64eb9fcfdb2f344bb48741af421688' as const;

export const OKF_SKILLS_VALIDATOR_SOURCE_URL =
  `https://raw.githubusercontent.com/scaccogatto/okf-skills/` +
  `${OKF_SKILLS_VALIDATOR_COMMIT}/skills/validate/scripts/okf_validate.py`;

// ── Interfaces ──────────────────────────────────────────────────────────────

/** Machine-readable `--json` report emitted by okf_validate.py. */
export interface OkfValidatorReport {
  readonly bundle: string;
  readonly conformant: boolean;
  readonly passed: boolean;
  readonly counts: {
    readonly concepts: number;
    readonly indexes: number;
    readonly logs: number;
  };
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly migrated: readonly string[];
}

/** One validator execution against a bundle directory. */
export interface OkfValidatorRun {
  /** Process exit code (0 = passed, 1 = failed, 2 = usage error). */
  readonly exitCode: number;
  /** Parsed `--json` report; null when the script did not emit one. */
  readonly report: OkfValidatorReport | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The exact command that was run, for failure diagnostics. */
  readonly command: string;
}

/**
 * The resolved validator handle. `ready === false` means the real validator
 * could not be obtained/run; the caller MUST skip (never pass) with `reason`.
 */
export interface OkfSkillsValidator {
  readonly ready: boolean;
  /** Human-readable reason when `ready === false` (why the check skipped). */
  readonly reason?: string;
  /** Absolute path of the pinned okf_validate.py on disk. */
  readonly scriptPath?: string;
  /** Run the real validator against a bundle directory (default mode). */
  run(bundleDir: string): Promise<OkfValidatorRun>;
  /** Remove the temp dir holding the downloaded script. */
  dispose(): Promise<void>;
}

// ── Availability probes ─────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 15_000;

function probeOk(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function pythonHasPyyaml(python: string): boolean {
  return probeOk(python, ['-c', 'import yaml']);
}

type Runtime =
  | { readonly kind: 'uv' }
  | { readonly kind: 'python'; readonly python: string };

function resolveRuntime(): { runtime?: Runtime; reason?: string } {
  const explicit = process.env['TEAMEM_OKF_VALIDATOR_RUNTIME'];
  if (explicit !== undefined && explicit !== '') {
    if (explicit === 'uv') {
      if (probeOk('uv', ['--version'])) return { runtime: { kind: 'uv' } };
      return { reason: 'TEAMEM_OKF_VALIDATOR_RUNTIME=uv but no `uv` binary is on PATH' };
    }
    if (explicit === 'python3') {
      if (pythonHasPyyaml('python3')) {
        return { runtime: { kind: 'python', python: 'python3' } };
      }
      return {
        reason:
          'python3 cannot import pyyaml (install it, or use uv via ' +
          'TEAMEM_OKF_VALIDATOR_RUNTIME=uv)',
      };
    }
    // Absolute/relative interpreter path
    if (pythonHasPyyaml(explicit)) {
      return { runtime: { kind: 'python', python: explicit } };
    }
    return {
      reason: `TEAMEM_OKF_VALIDATOR_RUNTIME interpreter \`${explicit}\` cannot import pyyaml`,
    };
  }
  if (probeOk('uv', ['--version'])) return { runtime: { kind: 'uv' } }; // preferred: self-provisions pyyaml
  if (pythonHasPyyaml('python3')) return { runtime: { kind: 'python', python: 'python3' } };
  return {
    reason:
      'no validator runtime: `uv` not found and `python3` cannot import pyyaml ' +
      '(install uv, or pip install pyyaml, or set TEAMEM_OKF_VALIDATOR_RUNTIME)',
  };
}

// ── Script acquisition ──────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function obtainScript(): Promise<
  { path: string; tmpDir: string } | { reason: string }
> {
  const local = process.env['TEAMEM_OKF_VALIDATOR_SCRIPT'];
  if (local !== undefined && local !== '') {
    try {
      const text = await readFile(local, 'utf8');
      const digest = sha256(text);
      if (digest !== OKF_SKILLS_VALIDATOR_SHA256) {
        return {
          reason: `TEAMEM_OKF_VALIDATOR_SCRIPT ${local} is not the pinned okf_validate.py ` +
            `(sha256 ${digest}, expected ${OKF_SKILLS_VALIDATOR_SHA256})`,
        };
      }
      return { path: local, tmpDir: '' };
    } catch (err) {
      return {
        reason: `TEAMEM_OKF_VALIDATOR_SCRIPT ${local} is unreadable: ${errMessage(err)}`,
      };
    }
  }

  const url =
    process.env['TEAMEM_OKF_VALIDATOR_URL'] ?? OKF_SKILLS_VALIDATOR_SOURCE_URL;
  let response: globalThis.Response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    return {
      reason: `cannot download the okf-skills validator from ${url}: ${errMessage(err)}` +
        ' (no network? set TEAMEM_OKF_VALIDATOR_SCRIPT to a local pinned copy)',
    };
  }
  if (!response.ok) {
    return {
      reason: `cannot download the okf-skills validator from ${url}: HTTP ${response.status}`,
    };
  }
  const text = await response.text();
  const digest = sha256(text);
  if (digest !== OKF_SKILLS_VALIDATOR_SHA256) {
    return {
      reason: `downloaded validator from ${url} has unexpected sha256 ${digest} ` +
        `(expected ${OKF_SKILLS_VALIDATOR_SHA256}) — refusing to run an unpinned script`,
    };
  }
  const tmpDir = await mkdtemp(join(tmpdir(), 'teamem-okf-validator-'));
  const path = join(tmpDir, 'okf_validate.py');
  await writeFile(path, text);
  return { path, tmpDir };
}

// ── Report parsing ──────────────────────────────────────────────────────────

function parseReport(stdout: string): OkfValidatorReport | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['passed'] === 'boolean' &&
      typeof (parsed as Record<string, unknown>)['conformant'] === 'boolean' &&
      Array.isArray((parsed as Record<string, unknown>)['errors'])
    ) {
      return parsed as OkfValidatorReport;
    }
  } catch {
    // not JSON — leave report null; the caller falls back to exitCode/output
  }
  return null;
}

// ── Public entry point ──────────────────────────────────────────────────────

/** Handle for an unavailable validator: run() must never be called. */
function unavailableValidator(reason: string): OkfSkillsValidator {
  return {
    ready: false,
    reason,
    run: async () => {
      throw new Error(
        `okf-skills validator unavailable (${reason}) — run() must not be called; the test should have skipped`,
      );
    },
    dispose: async () => undefined,
  };
}

/**
 * Acquire the pinned real okf-skills validator, or report exactly why it is
 * unavailable. `ready === false` must map to a skipped test with `reason` —
 * never to a pass.
 */
export async function acquireOkfSkillsValidator(): Promise<OkfSkillsValidator> {
  const script = await obtainScript();
  if ('reason' in script) {
    return unavailableValidator(script.reason);
  }
  const resolved = resolveRuntime();
  if (resolved.runtime === undefined) {
    await rm(script.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return unavailableValidator(resolved.reason ?? 'no validator runtime');
  }
  const runtime = resolved.runtime;
  const { path: scriptPath, tmpDir } = script;

  const run = async (bundleDir: string): Promise<OkfValidatorRun> => {
    const executable = runtime.kind === 'uv' ? 'uv' : runtime.python;
    const prefix = runtime.kind === 'uv' ? 'uv run --script' : executable;
    const args =
      runtime.kind === 'uv'
        ? ['run', '--script', scriptPath, bundleDir, '--json']
        : [scriptPath, bundleDir, '--json'];
    const command = `${prefix} ${scriptPath} ${bundleDir} --json`;
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { exitCode: 0, report: parseReport(stdout), stdout, stderr, command };
    } catch (err) {
      const failed = err as { code?: number | string; stdout?: string; stderr?: string };
      const stdout = failed.stdout ?? '';
      return {
        exitCode: typeof failed.code === 'number' ? failed.code : 1,
        report: parseReport(stdout),
        stdout,
        stderr: failed.stderr ?? '',
        command,
      };
    }
  };

  return {
    ready: true,
    scriptPath,
    run,
    dispose: () => rm(tmpDir, { recursive: true, force: true }),
  };
}