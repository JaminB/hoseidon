import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

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
        theme_color: '#0e1417',
        background_color: '#0e1417',
        display: 'standalone',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/hooks\//] },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/hooks': 'http://localhost:8787' },
  },
});
