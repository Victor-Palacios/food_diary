/**
 * Build-time configuration.
 *
 * Everything in this file is inlined into the client bundle. That is true of
 * any bundler-inlined value, wherever it came from -- a .env file or a
 * Cloudflare build variable makes no difference. So nothing secret is ever
 * read here. The Supabase anon key is designed to be public, and Row Level
 * Security is what actually protects the data.
 *
 * Real secrets (the NVIDIA API key) live in Worker secret bindings and are
 * only ever touched server-side.
 */

// `import.meta.env` is absent outside Vite, so the optional chain keeps this
// module importable from plain Node for tests.
const env = (import.meta.env ?? {}) as Record<string, string | undefined>

export const SUPABASE_URL = env.VITE_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY ?? ''

/**
 * A missing variable is reported through the UI rather than thrown at module
 * load -- a bare throw during import gives a blank white screen with the real
 * cause buried in the console.
 */
export const CONFIG_ERROR: string | null = (() => {
  const missing: string[] = []
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL')
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY')
  if (missing.length === 0) return null
  return `Missing ${missing.join(' and ')}.`
})()

/**
 * The single fixed timezone that defines the day boundary. Nothing is eaten
 * past midnight, so there is no rollover rule -- `eaten_on` is simply the
 * calendar day in this zone.
 */
export const TIMEZONE: string = env.VITE_TIMEZONE || 'America/Los_Angeles'

/** The block length the whole product is built around. */
export const BLOCK_DAYS = 21

/** Quick-tap multiplier presets. These cover the overwhelming majority of use. */
export const MULTIPLIER_PRESETS = [0.5, 1, 1.5, 2, 3]

/** numeric(5,2) in the database, and the CHECK is `> 0 and <= 20`. */
export const MULTIPLIER_MIN = 0.01
export const MULTIPLIER_MAX = 20
