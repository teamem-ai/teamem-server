/**
 * Composition-root wiring (M0-PLAT-06) — topology decision + shutdown ordering.
 *
 * These are pure wiring assertions over fakes: the real dependency (Postgres +
 * pg-boss) is exercised end to end in composition-root.integration.test.ts. The
 * behaviour pinned here is the task's contract:
 *
 *   - allInOne=true  → exactly one embedded worker.
 *   - allInOne=false → zero workers.
 *   - shutdown order  → worker → queue → HTTP server → database.
 *   - startup failure → already-started resources torn down, nothing orphaned.
 */
import { describe, expect, it, vi } from 'vitest';
import { startRuntime, type RuntimeStartup } from './composition-root.js';

/** Build fake startup factories that record the order resources stop in. */
function makeStartup(overrides: Partial<RuntimeStartup> = {}): {
  startup: RuntimeStartup;
  stopOrder: string[];
  startWorker: ReturnType<typeof vi.fn>;
} {
  const stopOrder: string[] = [];
  const resource = (name: string) => ({
    stop: vi.fn(async () => {
      stopOrder.push(name);
    }),
  });
  const startWorker = vi.fn(async () => resource('worker'));

  const startup: RuntimeStartup = {
    startDatabase: vi.fn(async () => resource('database')),
    startQueue: vi.fn(async () => resource('queue')),
    startHttpServer: vi.fn(async () => resource('httpServer')),
    startWorker,
    ...overrides,
  };

  return { startup, stopOrder, startWorker };
}

describe('startRuntime', () => {
  it('allInOne=true starts exactly one embedded worker', async () => {
    const { startup, startWorker } = makeStartup();
    const runtime = await startRuntime({ allInOne: true }, startup);

    expect(runtime.workerCount).toBe(1);
    expect(startWorker).toHaveBeenCalledTimes(1);
  });

  it('allInOne=false starts no worker', async () => {
    const { startup, startWorker } = makeStartup();
    const runtime = await startRuntime({ allInOne: false }, startup);

    expect(runtime.workerCount).toBe(0);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('shuts down in order: worker → queue → HTTP server → database', async () => {
    const { startup, stopOrder } = makeStartup();
    const runtime = await startRuntime({ allInOne: true }, startup);

    await runtime.shutdown();

    expect(stopOrder).toEqual(['worker', 'queue', 'httpServer', 'database']);
  });

  it('when no worker ran, shutdown skips it and keeps the rest ordered', async () => {
    const { startup, stopOrder } = makeStartup();
    const runtime = await startRuntime({ allInOne: false }, startup);

    await runtime.shutdown();

    expect(stopOrder).toEqual(['queue', 'httpServer', 'database']);
  });

  it('shutdown is idempotent (second call stops nothing again)', async () => {
    const { startup, stopOrder } = makeStartup();
    const runtime = await startRuntime({ allInOne: true }, startup);

    await runtime.shutdown();
    await runtime.shutdown();

    expect(stopOrder).toEqual(['worker', 'queue', 'httpServer', 'database']);
  });

  it('rolls back already-started resources when a later start fails', async () => {
    const { startup, stopOrder } = makeStartup({
      // HTTP server fails to bind after DB + queue already started.
      startHttpServer: vi.fn(async () => {
        throw new Error('EADDRINUSE');
      }),
    });

    await expect(startRuntime({ allInOne: true }, startup)).rejects.toThrow('EADDRINUSE');

    // DB and queue were up; they must be torn down in the mandated order.
    // The worker never started (HTTP failed first), so it is absent.
    expect(stopOrder).toEqual(['queue', 'database']);
    expect(startup.startWorker).not.toHaveBeenCalled();
  });
});
