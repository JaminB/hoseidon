import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  // Bundle the workspace package (it ships as TS source); keep native deps external.
  noExternal: ['@hoseidon/shared'],
  external: ['better-sqlite3'],
});
