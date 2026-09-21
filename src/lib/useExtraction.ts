import { useEffect, useState } from 'react'

/**
 * Is Phase 2 wired up on this deployment? Asked once per session and cached,
 * so the photo buttons either exist or do not, with no flicker between.
 *
 * A failed probe means "no": the app is Phase 1 first and must work perfectly
 * with the extraction service absent, unreachable, or never configured.
 */
let cached: Promise<boolean> | null = null

function probe(): Promise<boolean> {
  cached ??= fetch('/api/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((body: unknown) =>
      Boolean(body && typeof body === 'object' && (body as { extraction?: unknown }).extraction),
    )
    .catch(() => false)
  return cached
}

/**
 * Seconds since `running` became true, for the wait indicator.
 *
 * A model call can legitimately take a minute or more, and a button that
 * just says "working" for that long is indistinguishable from a hung one.
 */
export function useElapsedSeconds(running: boolean): number {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (!running) {
      setSeconds(0)
      return
    }
    const startedAt = Date.now()
    const id = setInterval(
      () => setSeconds(Math.round((Date.now() - startedAt) / 1000)),
      1000,
    )
    return () => clearInterval(id)
  }, [running])

  return seconds
}

export function useExtractionAvailable(): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    let live = true
    void probe().then((v) => {
      if (live) setAvailable(v)
    })
    return () => {
      live = false
    }
  }, [])

  return available
}
