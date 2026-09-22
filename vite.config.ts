import { execSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * A visible build stamp, shown in Settings.
 *
 * "Which version am I actually looking at" is otherwise unanswerable from a
 * phone, which turns every bug report into guesswork. That mattered most when
 * this app had a service worker; it is still worth the two lines.
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
 * without opening the app, signing in, or trusting a screenshot. Fetched
 * no-store by UpdateBanner, since a cached copy would defeat its purpose.
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
      /**
       * No service worker. This app is installable, not offline-capable.
       *
       * "Installable" is the manifest below: home-screen icon, standalone
       * display, no browser chrome. An offline app shell is a separate thing,
       * and shipping one was a mistake here -- offline-first was explicitly
       * out of scope, and the precached shell bought nothing the product
       * needed while costing something it did need.
       *
       * What it cost: a service worker answers navigations from its own
       * storage without asking the network, so `cache-control` does not
       * govern it and a reload does not bypass it. On an installed iOS PWA
       * the browser only re-checks the worker script on a navigation, and a
       * home-screen app never navigates -- it suspends and resumes. So a
       * phone could run week-old JavaScript against a current API for days.
       * That was not a cosmetic problem: an old client called .json() on a
       * newline-delimited stream, the parse threw, and null normalised into
       * an all-zeros form with a 200 status. It looked like a model failure.
       *
       * Without a worker the ordinary web rules apply, and they are enough:
       * asset filenames are content-hashed, so a stale copy is unreachable
       * rather than wrong, and index.html is served must-revalidate, so the
       * one unhashable file is checked every time. Staleness stops being a
       * failure mode instead of being something the app has to detect.
       *
       * `selfDestroying` still emits a worker, whose only job is to unregister
       * itself and delete its caches. That is deliberate: dropping sw.js from
       * the build would not remove it from a phone that already installed one
       * -- that worker keeps serving its precached shell. This replaces it and
       * cleans up. Removable once no install predates this build.
       */
      selfDestroying: true,
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
