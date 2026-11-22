import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Booting workerd and bundling the Worker takes a while on a cold machine.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
