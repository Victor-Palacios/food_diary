/**
 * A service worker whose only job is to remove itself.
 *
 * This app used to precache its shell. That is gone -- it is installable, not
 * offline-capable -- but deleting the file would not have been enough:
 * a phone that already installed the old worker keeps running it, and that
 * worker answers navigations from its own cache, so it would serve last
 * week's app forever without ever asking the network.
 *
 * A worker is only replaced by another worker. So this one ships, gets picked
 * up by the browser's update check, and tears the whole arrangement down.
 *
 * Order matters, and each step here exists because leaving it out fails:
 *
 *   claim()     -- WindowClient.navigate() throws unless this worker controls
 *                  the page, and matchAll() without includeUncontrolled only
 *                  ever returns pages it controls. vite-plugin-pwa's canned
 *                  version omits both, so it never reloads anything and only
 *                  converges on the user's *next* visit. Tested: it took two.
 *   caches      -- deleted before anything reloads, so nothing stale can be
 *                  served into the new page.
 *   unregister  -- before the reload, so the fresh page comes up with no
 *                  registration at all and its guard does not re-register.
 *   navigate    -- the page is still running the old bundle out of the old
 *                  cache at this point. Only a navigation replaces it.
 *
 * Deletable once no install predates the build that added it.
 */
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim()

      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      const names = await self.caches.keys()
      await Promise.all(names.map((name) => self.caches.delete(name)))

      for (const client of windows) {
        // The reload carries a marker so the fresh page knows it is the
        // product of a cleanup and skips its registration guard. Without it
        // the guard sees this worker as the controller, registers again, and
        // that resurrects the very registration being torn down -- leaving a
        // permanent no-op worker installed. Measured; it never reached zero.
        const url = new URL(client.url)
        url.searchParams.set('swreset', '1')

        // Deliberately not awaited. navigate() resolves only once the new
        // document has loaded, and that load waits on this activation to
        // finish -- so awaiting it deadlocks the worker in "activating"
        // forever, caches half-cleared and the page still on the old bundle.
        // Observed exactly that; the reload never fired.
        client.navigate(url.href).catch(() => {
          /* The next open is clean regardless: no worker, no caches. */
        })
      }

      // Last, because unregistering releases this worker's control of the
      // page and navigate() on an uncontrolled client does nothing. Also
      // observed: with unregister first, every step logged success and the
      // page still sat on the old build.
      await self.registration.unregister()
    })(),
  )
})
