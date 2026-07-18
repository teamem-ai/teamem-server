/**
 * M0-PLAT-05 — server and worker entrypoint lifecycle tests.
 *
 * Pins the behavior the task requires:
 *  - success: SIGTERM/SIGINT trigger a single graceful shutdown that exits 0;
 *  - failure: a missing or illegal DATABASE_URL exits NON-ZERO (fail fast);
 *  - boundary/safety: shutdown runs at most once even under a double signal,
 *    a hung teardown is force-exited non-zero, and credentials never leak into
 *    a log line.
 *
 * Two layers:
 *  1. Unit tests drive the lifecycle helpers directly (no process kill — exit
 *     and the signal listener are invoked through injection seams).
 *  2. Process tests spawn the real index.ts / worker.ts entrypoints. The
 *     startup-failure cases need no database; the clean-shutdown cases require
 *     a reachable Postgres and honestly skip via TEST_DATABASE_URL when absent.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeHttpServer,
  fatalStartup,
  installShutdownHandlers,
  scrubSecrets,
} from './lifecycle.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const tsxBin = resolve(serverRoot, 'node_modules/.bin/tsx');

/** Let the injected-exit promise chain in installShutdownHandlers settle. */
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('M0-PLAT-05 lifecycle helpers (unit)', () => {
  it('scrubSecrets redacts credentials in a connection string (redaction red line)', () => {
    const scrubbed = scrubSecrets('connect failed for postgres://teamem:s3cret@host:5432/db');
    expect(scrubbed).toContain('postgres://***@host:5432/db');
    expect(scrubbed).not.toContain('s3cret');
  });

  it('fatalStartup exits non-zero with a scrubbed message', () => {
    const exit = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fatalStartup(new Error('boom postgres://u:p@h/db'), exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.flat().join(' ')).not.toContain('u:p');
    err.mockRestore();
  });

  describe('installShutdownHandlers', () => {
    let disposer: (() => void) | undefined;

    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      disposer?.();
      disposer = undefined;
      vi.restoreAllMocks();
    });

    /** Capture the SIGTERM listener installed by the helper without signaling. */
    function install(shutdown: Parameters<typeof installShutdownHandlers>[0], exit: (c: number) => void) {
      const before = new Set(process.listeners('SIGTERM'));
      disposer = installShutdownHandlers(shutdown, { exit, forceExitMs: 50 });
      const added = process.listeners('SIGTERM').filter((l) => !before.has(l));
      expect(added).toHaveLength(1);
      return added[0] as () => void;
    }

    it('a signal runs teardown once and exits 0', async () => {
      const shutdown = vi.fn().mockResolvedValue(undefined);
      const exit = vi.fn();
      const trigger = install(shutdown, exit);
      trigger();
      await flush();
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('a second signal is ignored — teardown runs at most once', async () => {
      const shutdown = vi.fn().mockResolvedValue(undefined);
      const exit = vi.fn();
      const trigger = install(shutdown, exit);
      trigger();
      trigger();
      await flush();
      expect(shutdown).toHaveBeenCalledTimes(1);
    });

    it('teardown failure exits non-zero', async () => {
      const shutdown = vi.fn().mockRejectedValue(new Error('close failed'));
      const exit = vi.fn();
      const trigger = install(shutdown, exit);
      trigger();
      await flush();
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('a hung teardown is force-exited non-zero', async () => {
      const shutdown = vi.fn().mockReturnValue(new Promise<void>(() => {})); // never resolves
      const exit = vi.fn();
      const trigger = install(shutdown, exit);
      trigger();
      await new Promise((r) => setTimeout(r, 120)); // > forceExitMs (50)
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it('closeHttpServer resolves on clean close and rejects on error', async () => {
    await expect(closeHttpServer({ close: (cb) => cb() })).resolves.toBeUndefined();
    await expect(
      closeHttpServer({ close: (cb) => cb(new Error('still open')) }),
    ).rejects.toThrow(/still open/);
  });
});

// ── Process-level lifecycle (spawns the real entrypoints) ────────────────────

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
}

/**
 * Spawn a TS entrypoint via tsx (which forwards SIGTERM/SIGINT to the child and
 * propagates its exit code). When `killWhenReady` is set, wait for a readiness
 * line then send that signal; otherwise let the process exit on its own.
 */
function runEntry(
  entry: 'index.ts' | 'worker.ts',
  env: NodeJS.ProcessEnv,
  killWhenReady?: NodeJS.Signals,
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tsxBin, [resolve(serverRoot, 'src', entry)], {
      cwd: serverRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let signaled = false;
    const onData = (d: Buffer) => {
      out += d.toString();
      if (killWhenReady && !signaled && /ready/i.test(out)) {
        signaled = true;
        setTimeout(() => child.kill(killWhenReady), 100);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolvePromise({ code, signal, out }));
  });
}

describe('M0-PLAT-05 entrypoint startup failure (process)', () => {
  const baseEnv = { ...process.env };
  delete baseEnv['DATABASE_URL'];
  delete baseEnv['TEST_DATABASE_URL'];

  it('server exits non-zero when DATABASE_URL is missing', { timeout: 30_000 }, async () => {
    const res = await runEntry('index.ts', baseEnv);
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/startup failed/);
  });

  it('worker exits non-zero when DATABASE_URL is missing', { timeout: 30_000 }, async () => {
    const res = await runEntry('worker.ts', baseEnv);
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/startup failed/);
  });

  it('server exits non-zero on an illegal/unreachable DATABASE_URL', { timeout: 30_000 }, async () => {
    const res = await runEntry('index.ts', {
      ...baseEnv,
      DATABASE_URL: 'postgres://teamem:wrong@127.0.0.1:1/teamem',
    });
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/startup failed/);
    // The password must not leak into logs even on failure.
    expect(res.out).not.toContain('wrong');
  });

  it('worker exits non-zero on an illegal/unreachable DATABASE_URL', { timeout: 30_000 }, async () => {
    const res = await runEntry('worker.ts', {
      ...baseEnv,
      DATABASE_URL: 'postgres://teamem:wrong@127.0.0.1:1/teamem',
    });
    expect(res.code).not.toBe(0);
    expect(res.out).not.toContain('wrong');
  });
});

const testDbUrl = process.env['TEST_DATABASE_URL'];

describe.skipIf(!testDbUrl)('M0-PLAT-05 graceful shutdown (process, real Postgres)', () => {
  it('server starts, then SIGTERM exits 0 cleanly', { timeout: 30_000 }, async () => {
    const res = await runEntry(
      'index.ts',
      { ...process.env, DATABASE_URL: testDbUrl, TEAMEM_PORT: '8137' },
      'SIGTERM',
    );
    expect(res.out).toMatch(/server ready/i);
    expect(res.out).toMatch(/shutting down gracefully/);
    expect(res.code).toBe(0);
  });

  it('server also handles SIGINT cleanly', { timeout: 30_000 }, async () => {
    const res = await runEntry(
      'index.ts',
      { ...process.env, DATABASE_URL: testDbUrl, TEAMEM_PORT: '8138' },
      'SIGINT',
    );
    expect(res.code).toBe(0);
  });

  it('worker starts, then SIGTERM exits 0 cleanly', { timeout: 30_000 }, async () => {
    const res = await runEntry('worker.ts', { ...process.env, DATABASE_URL: testDbUrl }, 'SIGTERM');
    expect(res.out).toMatch(/worker ready/i);
    expect(res.out).toMatch(/shutting down gracefully/);
    expect(res.code).toBe(0);
  });

  it('worker also handles SIGINT cleanly', { timeout: 30_000 }, async () => {
    const res = await runEntry('worker.ts', { ...process.env, DATABASE_URL: testDbUrl }, 'SIGINT');
    expect(res.code).toBe(0);
  });
});
