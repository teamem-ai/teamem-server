import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  // yaml is declared in dependencies and must stay external: it is pure CJS
  // and calls require('process') inside function bodies, which a bundled ESM
  // output cannot convert (tsup's __require shim throws under Node ESM).
  // npm consumers install yaml as a transitive dependency, so the import
  // resolves normally at runtime.
  external: ['yaml'],
});
