/**
 * teamem compile worker — pg-boss consumer (AGPL-3.0-only)
 *
 * M0 skeleton: the worker process that dequeues compilation jobs from
 * pg-boss and runs F1/F2. Real implementation lands with the first
 * compile task. This file exists so the `worker` script and
 * `docker-compose.yml` command: ["node", "apps/server/dist/worker.js"]
 * resolve to a real entrypoint today.
 *
 * Do NOT fabricate compile results or hard-code demo data.
 */
const isMain =
  process.argv[1]?.endsWith('/worker.js') ||
  process.argv[1]?.endsWith('/worker.ts');

if (isMain) {
  console.log('teamem worker starting (M0 skeleton — no compile jobs yet)');
  console.log('Waiting for pg-boss queue implementation (M0 compile tasks).');
}

export {};
