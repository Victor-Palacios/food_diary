import { useEffect, useState } from 'react'

/**
 * Tells you when the running code is older than what is deployed.
 *
 * An installed PWA holds its bundle through reloads, and iOS is especially
 * reluctant to let go. That produced several rounds of "the fix did not
 * work" when the fix was live and the phone was simply running last week's
 * JavaScript against a newer API. The app can see this for itself: compare
 * the build compiled into this bundle against /version.json, which is
 * served fresh.
 *
 * Reloading is not enough on its own, so the button unregisters the service
 * worker and clears its caches first.
 */
export function UpdateBanner() {
  const [stale, setStale] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true

    const check = async () => {
      try {
        const res = await fetch('/version.json', { cache: 'no-store' })
        if (!res.ok) return
        const { build } = (await res.json()) as { build?: string }
        if (live && build && build !== __BUILD_STAMP__) setStale(build)
      } catch {
        // Offline, or the file is not there yet. Nothing to tell the user.
      }
    }

    void check()
    // Re-check when the app comes back to the foreground, which on a phone
    // is the moment a deploy is most likely to have happened since.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!stale) return null

  async function update() {
    setBusy(true)
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
      }
      if ('caches' in window) {
        const names = await caches.keys()
        await Promise.all(names.map((n) => caches.delete(n)))
      }
    } catch {
      // Best effort; the reload below is the part that matters.
    }
    // Cache-busting query so the HTML itself is refetched.
    location.replace(`${location.pathname}?v=${Date.now()}`)
  }

  return (
    <div className="update-banner">
      <div className="grow">
        <strong>A newer version is available.</strong>
        <div className="sub">
          This app is running {__BUILD_STAMP__.split(' · ')[0]}; {stale.split(' · ')[0]} is
          deployed.
        </div>
      </div>
      <button className="btn primary sm" onClick={() => void update()} disabled={busy}>
        {busy ? 'Updating…' : 'Update'}
      </button>
    </div>
  )
}
