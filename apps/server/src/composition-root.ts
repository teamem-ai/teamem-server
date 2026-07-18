/**
 * Composition root — all-in-one wiring (AGPL-3.0-only, M0-PLAT-06).
 *
 * This is the single place that decides the runtime topology:
 *
 *   TEAMEM_ALL_IN_ONE=true  -> start exactly one embedded compile worker.
 *   TEAMEM_ALL_IN_ONE=false -> start no worker (the worker runs as its own
 *                              process in the 3-container topology).
 *
 * It also owns shutdown ordering. Resources start DB -> queue -> HTTP -> worker
 * (each depends on the ones before it), and stop in the order the task mandates:
 *
 *   worker -> queue -> HTTP server -> database
 *
 * The worker stops first so no new compile work is claimed; the queue stops
 * next so nothing else is dequeued; the HTTP server stops so no new ingest is
 * accepted; the database drains last, once nothing else can touch it.
 *
 * Startup and shutdown live behind injected factories so the ordering and the
 * worker-count decision are unit-testable with fakes, and exercised for real
 * against Postgres + pg-boss in the integration test.
 */

/** A started resource that can be torn down. */
export interface StoppableResource {
  stop(): Promise<void>;
}

/**
 * Factories the composition root drives. Each returns a handle whose `stop()`
 * tears the resource down. `startWorker` is invoked at most once, and only when
 * `allInOne` is true.
 */
export interface RuntimeStartup {
  startDatabase(): Promise<StoppableResource>;
  startQueue(): Promise<StoppableResource>;
  startHttpServer(): Promise<StoppableResource>;
  startWorker(): Promise<StoppableResource>;
}

export interface Runtime {
  /** 1 when a worker was embedded, 0 otherwise. */
  readonly workerCount: 0 | 1;
  /** Idempotent, ordered teardown: worker -> queue -> HTTP -> database. */
  shutdown(): Promise<void>;
}

type ResourceName = 'worker' | 'queue' | 'httpServer' | 'database';

/** Fixed teardown order required by M0-PLAT-06. */
const SHUTDOWN_ORDER: readonly ResourceName[] = ['worker', 'queue', 'httpServer', 'database'];

/**
 * Start the runtime. On any startup failure, already-started resources are torn
 * down in the mandated order before the error propagates, so a failed boot
 * leaves nothing running (no orphaned pg-boss connection, no bound socket).
 */
export async function startRuntime(
  config: { allInOne: boolean },
  startup: RuntimeStartup,
  log: (message: string) => void = () => {},
): Promise<Runtime> {
  const started = new Map<ResourceName, StoppableResource>();

  const shutdown = async (): Promise<void> => {
    for (const name of SHUTDOWN_ORDER) {
      const resource = started.get(name);
      if (!resource) continue;
      // Remove before awaiting so a concurrent/duplicate shutdown is a no-op.
      started.delete(name);
      log(`stopping ${name}`);
      await resource.stop();
    }
  };

  try {
    started.set('database', await startup.startDatabase());
    log('database started');
    started.set('queue', await startup.startQueue());
    log('queue started');
    started.set('httpServer', await startup.startHttpServer());
    log('http server started');

    let workerCount: 0 | 1 = 0;
    if (config.allInOne) {
      started.set('worker', await startup.startWorker());
      workerCount = 1;
      log('embedded worker started (all-in-one)');
    } else {
      log('no embedded worker (TEAMEM_ALL_IN_ONE=false)');
    }

    return { workerCount, shutdown };
  } catch (err) {
    await shutdown();
    throw err;
  }
}
