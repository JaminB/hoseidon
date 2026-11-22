import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  // Bundle the workspace package (TS source) and rrule (its CJS build has no named ESM exports);
  // keep native deps external.
  noExternal: ['@hoseidon/shared', 'rrule'],
  external: ['better-sqlite3'],
});
