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
  // tsup auto-externalises packages listed in dependencies. Force-bundle
  // @teamem/schema so the production runtime never loads raw TypeScript
  // files (the schema package has no build step and exports .ts source).
  noExternal: ['@teamem/schema'],
});
