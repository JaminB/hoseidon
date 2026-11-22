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
    // Offline app shell (precached build) plus push handlers. API data is not cached by the
    // service worker: TanStack Query persists the last responses to IndexedDB instead.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Hoseidon',
        short_name: 'Hoseidon',
        description: 'God of the garden hose.',
        theme_color: '#1690ad',
        background_color: '#111518',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        importScripts: ['push-sw.js'],
        navigateFallbackDenylist: [/^\/api\//, /^\/hooks\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  server: {
    port: 5173,
    // Keep the browser's Host header (no changeOrigin): the server's CSRF check compares it to Origin.
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/hooks': { target: api, changeOrigin: false },
    },
  },
  // A fixed zone with DST, so the calendar tests mean the same thing on every machine.
  test: { include: ['src/**/*.test.ts'], env: { TZ: 'America/New_York' } },
});
