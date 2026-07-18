/**
 * Process lifecycle shared by the server (index.ts) and worker (worker.ts)
 * entrypoints (AGPL-3.0-only).
 *
 * This module owns only the parts unique to running as a long-lived process:
 *  - a single graceful shutdown driven by SIGTERM/SIGINT that exits 0 after
 *    teardown, with a force-exit safety net so a hung close never leaves a
 *    zombie;
 *  - turning a startup failure into an honest NON-ZERO exit;
 *  - scrubbing credentials out of anything derived from an error before it
 *    reaches a log line (red line: logs must not leak secrets).
 *
 * Config parsing (config/env.ts) and database connect/verify/close
 * (db/client.ts) are reused from the platform modules — they are not
 * re-implemented here.
 */

/** Teardown callback invoked once when a shutdown signal arrives. */
export type ShutdownFn = (signal: NodeJS.Signals) => Promise<void> | void;

/** Injection seam so unit tests can observe exits without killing the runner. */
export type ExitFn = (code: number) => void;

const DEFAULT_FORCE_EXIT_MS = 10_000;

const defaultExit: ExitFn = (code) => process.exit(code);

/**
 * Replace the credentials in any `scheme://user:pass@host` substring with
 * `***`. Postgres/pg errors rarely echo the URL, but a single leak of the
 * password would violate the redaction red line, so scrub defensively.
 */
export function scrubSecrets(message: string): string {
  return message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]*@/gi, '$1***@');
}

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubSecrets(raw);
}

/**
 * Turn a startup failure into an honest non-zero exit. Logs a scrubbed message
 * and exits 1. Never resolves in production (process.exit); the injected exit
 * used in tests returns, so callers must not run further work after calling it.
 */
export function fatalStartup(err: unknown, exit: ExitFn = defaultExit): void {
  console.error('teamem: startup failed:', errText(err));
  exit(1);
}

/**
 * Wire SIGTERM/SIGINT to a single graceful shutdown.
 *
 * The teardown runs at most once even if both signals arrive; a second signal
 * while shutdown is in flight is ignored. On success the process exits 0; if
 * teardown throws it exits 1. A last-resort timer (unref'd, so it never keeps
 * the loop alive on a clean exit) force-exits non-zero if teardown hangs, so a
 * stuck dependency can never leave a zombie behind.
 *
 * Returns a disposer that detaches the listeners (used by unit tests).
 */
export function installShutdownHandlers(
  shutdown: ShutdownFn,
  opts: { exit?: ExitFn; forceExitMs?: number } = {},
): () => void {
  const exit = opts.exit ?? defaultExit;
  const forceExitMs = opts.forceExitMs ?? DEFAULT_FORCE_EXIT_MS;
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`teamem: received ${signal}, shutting down gracefully`);

    const force = setTimeout(() => {
      console.error('teamem: graceful shutdown timed out, forcing exit');
      exit(1);
    }, forceExitMs);
    // Do not let the safety timer itself keep the process alive.
    force.unref?.();

    // The shutdown chain is intentionally the process's last action: it always
    // terminates in exit(), so it is a completed unit of work, not a dangling
    // background promise.
    Promise.resolve()
      .then(() => shutdown(signal))
      .then(() => {
        clearTimeout(force);
        exit(0);
      })
      .catch((teardownErr: unknown) => {
        clearTimeout(force);
        console.error('teamem: error during shutdown:', errText(teardownErr));
        exit(1);
      });
  };

  const onTerm = (): void => handle('SIGTERM');
  const onInt = (): void => handle('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  return () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
}

/** Promisified `server.close()` for the Node HTTP listener. */
export function closeHttpServer(server: {
  close(cb: (err?: Error) => void): void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
