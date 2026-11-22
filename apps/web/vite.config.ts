import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// The dev proxy target; the Playwright smoke test points it at its own server.
const api = process.env.HOSEIDON_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Stub: manifest + offline shell. Push, richer caching and icons land in the PWA phase.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Hoseidon',
        short_name: 'Hoseidon',
        description: 'God of the garden hose.',
        theme_color: '#111518',
        background_color: '#111518',
        display: 'standalone',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/hooks\//] },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': api, '/hooks': api },
  },
  // A fixed zone with DST, so the calendar tests mean the same thing on every machine.
  test: { include: ['src/**/*.test.ts'], env: { TZ: 'America/New_York' } },
});
