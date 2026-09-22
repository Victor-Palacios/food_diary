/**
 * Regression test for public/sw.js, the worker that removes the old
 * precaching one. Reproduces the original stale-cache bug in a real browser
 * and proves the cleanup heals it.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/sw-cleanup-test.mjs
 *
 * Playwright is not a dependency of this project -- this verifies a mechanism
 * that is itself temporary, and both go away together.
 *
 * Expected: step 2 still shows the old build (if it does not, the test proves
 * nothing), then the timeline reaches the new build at zero registrations and
 * zero caches within a few seconds, and the loop check reports no extra
 * fetches while idle.
 *
 * Phase 1: install an old-style precaching worker, then change the server's
 *          HTML and JS. A reload must still show the old build -- that is the
 *          bug, and if it does not reproduce the rest of the test proves
 *          nothing.
 * Phase 2: serve the self-destroying sw.js this repo now ships. The
 *          registration must disappear, the caches must go, and the page must
 *          come up on the new build.
 *
 * 127.0.0.1 is a secure context, so service workers are allowed.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_SW = readFileSync(resolve(HERE, '../public/sw.js'), 'utf8')

// The worker this app used to ship: precache the shell, answer navigations
// from that cache without asking the network.
const OLD_SW = `
const CACHE = 'precache-v1'
const SHELL = ['/', '/app.js']
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('/').then((r) => r || fetch(e.request)))
    return
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)))
})
`

// guard=false is the OLD build's HTML (registers unconditionally, as
// vite-plugin-pwa's registerSW.js did); guard=true is the new build's.
const state = { build: 'v1', sw: OLD_SW, htmlServed: 0, guard: false }

const server = createServer((req, res) => {
  const url = req.url.split('?')[0]
  const send = (type, body) => {
    res.writeHead(200, {
      'content-type': type,
      // Exactly what Cloudflare serves for this app.
      'cache-control': 'public, max-age=0, must-revalidate',
    })
    res.end(body)
  }
  if (url === '/sw.js') return send('text/javascript', state.sw)
  if (url === '/app.js') return send('text/javascript', `document.title = 'build ${state.build}'`)
  if (url === '/' || url === '/index.html') {
    state.htmlServed++
    return send(
      'text/html',
      `<!doctype html><meta charset=utf-8><title>loading</title>
<body><div id=b>${state.build}</div>
<script src="/app.js"></script>
<script>
${
  state.guard
    ? `var swReset = location.search.indexOf('swreset=') !== -1
if ('serviceWorker' in navigator && navigator.serviceWorker.controller && !swReset) {
  navigator.serviceWorker.register('/sw.js')
}
if (swReset) { history.replaceState(null, '', location.pathname + location.hash) }`
    : `navigator.serviceWorker.register('/sw.js')`
}
</script>`,
    )
  }
  res.writeHead(404).end('no')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
const page = await browser.newPage()

// Surface everything the workers say, and any error they throw.
const swLog = []
page.on('console', (m) => swLog.push(`console/${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => swLog.push(`pageerror: ${e.message}`))
browser.contexts()[0].on('serviceworker', (w) => {
  swLog.push(`worker created: ${w.url()}`)
  w.on('console', (m) => swLog.push(`sw/${m.type()}: ${m.text()}`))
})

const probe = () =>
  page.evaluate(async () => ({
    shown: document.getElementById('b')?.textContent ?? null,
    title: document.title,
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    states: (await navigator.serviceWorker.getRegistrations()).map((r) => ({
      installing: r.installing?.state ?? null,
      waiting: r.waiting?.state ?? null,
      active: r.active?.state ?? null,
    })),
    caches: await caches.keys(),
  }))

const log = {}
const finish = async () => {
  log['sw log'] = swLog
  console.log(JSON.stringify(log, null, 2))
  await browser.close()
  server.close()
}
process.on('uncaughtException', async (e) => { log['THREW'] = String(e).split('\n')[0]; await finish(); process.exit(1) })
try {

// --- Phase 1: reproduce the bug -------------------------------------------
await page.goto(BASE, { waitUntil: 'load' })
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
log['1. old worker installed'] = await probe()

// Deploy a new build. Nothing about the server is cacheable, so a normal site
// would pick this up on the next request.
state.build = 'v2'
await page.reload({ waitUntil: 'load' })
log['2. after deploy + reload (bug)'] = await probe()

// --- Phase 2: ship the kill switch, then watch the timeline ---------------
state.sw = REAL_SW
state.guard = true
const t0 = Date.now()
await page.reload({ waitUntil: 'load' })

const timeline = []
let lastKey = ''
for (let i = 0; i < 40; i++) {
  let snap
  try {
    snap = await probe()
  } catch (e) {
    // A navigation in flight invalidates the execution context; that is
    // itself the signal we are waiting for.
    snap = { shown: 'NAVIGATING', registrations: -1, states: [], caches: [] }
  }
  const key = `${snap.shown} regs=${snap.registrations} active=${snap.states.map((x) => x.active)} caches=${snap.caches}`
  if (key !== lastKey) {
    timeline.push(`+${((Date.now() - t0) / 1000).toFixed(1)}s  ${key}`)
    lastKey = key
  }
  if (snap.shown === 'v2' && snap.registrations === 0) break
  await page.waitForTimeout(500)
}
log['phase 2 timeline'] = timeline

// A later deploy must now behave like an ordinary website.
state.build = 'v3'
await page.reload({ waitUntil: 'load' })
log['4. next deploy, no worker'] = await probe()

// A loop would keep fetching HTML long after things settled.
const served = state.htmlServed
await page.waitForTimeout(6000)
log['5. loop check'] = {
  htmlFetchesTotal: state.htmlServed,
  extraFetchesWhileIdle: state.htmlServed - served,
  finalRegistrations: (await probe()).registrations,
}

} catch (e) { log['THREW'] = String(e).split('\n')[0] }
await finish()
