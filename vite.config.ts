import { execSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * A visible build stamp, shown in Settings.
 *
 * An installed PWA can keep running old JavaScript long after a deploy, and
 * "which version am I actually looking at" is otherwise unanswerable from a
 * phone -- which turns every bug report into guesswork.
 */
function buildStamp(): string {
  const sha =
    process.env.WORKERS_CI_COMMIT_SHA ??
    process.env.CF_PAGES_COMMIT_SHA ??
    (() => {
      try {
        return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim()
      } catch {
        return 'dev'
      }
    })()
  return `${sha.slice(0, 7)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`
}

const STAMP = buildStamp()

/**
 * Writes the build stamp to /version.json as well as into the bundle.
 *
 * A URL anyone can curl answers "what is actually deployed right now"
 * without opening the app, signing in, or trusting a screenshot. Deliberately
 * not precached -- a cached version file would defeat its own purpose.
 */
function versionFile(): Plugin {
  return {
    name: 'emit-version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ build: STAMP }, null, 2) + '\n',
      })
    },
  }
}

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify(STAMP),
  },
  plugins: [
    react(),
    versionFile(),
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
        // Take over as soon as a new build is fetched rather than waiting for
        // every tab to close. An installed PWA is rarely "closed", so without
        // these a deploy can sit unused for days -- and a client running
        // against a newer API is how silent breakage happens.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
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
