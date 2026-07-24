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
  external: ['pg', 'pgvector'],
  // Force-bundle the workspace source so the server artifact remains
  // self-contained. External consumers receive @teamem/schema's built npm
  // artifact instead.
  noExternal: ['@teamem/schema'],
});
