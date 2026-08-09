import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    worker: 'src/worker.ts',
  },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  // pg and pgvector are native Node addons that must stay external.
  // yaml (used by @teamem/schema's OKF export contract) is pure CJS and
  // calls require('process') inside function bodies — esbuild/tsup cannot
  // convert that to an ESM import, and the runtime __require shim throws
  // under Node ESM. Keep it external so it is required from node_modules,
  // where yaml's own CJS machinery resolves 'process' natively. The
  // Dockerfile adds the matching top-level symlink (it is a transitive dep
  // of the server package, so pnpm deploy does not hoist one).
  external: ['pg', 'pgvector', 'yaml'],
  // Force-bundle the workspace source so the server artifact remains
  // self-contained. External consumers receive @teamem/schema's built npm
  // artifact instead.
  noExternal: ['@teamem/schema'],
});
