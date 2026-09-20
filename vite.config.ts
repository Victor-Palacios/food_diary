import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.png'],
      manifest: {
        name: 'Food Log',
        short_name: 'Food Log',
        description: 'Single-user food logging. One trustworthy number per 3-week block.',
        theme_color: '#12151a',
        background_color: '#12151a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // The app shell is cached so a cold open on a bad connection still
        // paints instantly. Supabase and the extraction endpoint are never
        // cached -- stale nutrition data is worse than no data.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    // ./dist is what wrangler.jsonc serves as the Worker's asset directory.
    outDir: 'dist',
    target: 'es2022',
  },
  server: {
    // `npm run dev` serves the SPA with HMR but does not run the Worker, so
    // /api/* is forwarded to `wrangler dev` on its default port. Run both
    // together only when working on Phase 2; Phase 1 needs neither.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
