import type { Metric } from './types'

/** What an unrecorded value looks like everywhere in the UI. */
export const NOT_RECORDED = '—'

/**
 * Renders a value that may be unrecorded. A dash is not a zero, and the
 * difference matters: fiber is routinely absent from labels, and showing 0
 * would understate it silently.
 */
export function formatOptional(metric: Metric, value: number | null | undefined): string {
  if (value === null || value === undefined) return NOT_RECORDED
  return formatMetric(metric, value)
}

/** Calories read as whole numbers; grams to one decimal, trailing .0 dropped. */
export function formatMetric(metric: Metric, value: number): string {
  if (metric === 'calories') return Math.round(value).toLocaleString('en-US')
  return formatGrams(value)
}

export function formatGrams(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function formatCalories(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

const VULGAR: Record<string, string> = {
  '0.25': '¼',
  '0.5': '½',
  '0.75': '¾',
  '0.33': '⅓',
  '0.67': '⅔',
}

/**
 * Renders a multiplier the way it would be said out loud: '½x', '1½x', '2x'.
 * Storage is always decimal -- this is presentation only.
 */
export function formatMultiplier(multiplier: number): string {
  const n = Math.round(multiplier * 100) / 100
  if (n <= 0) return `${n}x`

  const whole = Math.floor(n)
  const frac = Math.round((n - whole) * 100) / 100
  const glyph = VULGAR[String(frac)]

  if (frac === 0) return `${whole}x`
  if (glyph) return whole === 0 ? `${glyph}x` : `${whole}${glyph}x`
  return `${trimDecimal(n)}x`
}

function trimDecimal(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** Parses free numeric multiplier input. Returns null when unusable. */
export function parseMultiplier(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null

  // Accept '1 1/2', '1/2' and '3/4' alongside plain decimals -- a fraction is
  // often what the packet actually says.
  const mixed = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(text)
  if (mixed) {
    const denom = Number(mixed[3])
    if (denom === 0) return null
    return Number(mixed[1]) + Number(mixed[2]) / denom
  }

  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(text)
  if (fraction) {
    const denom = Number(fraction[2])
    if (denom === 0) return null
    return Number(fraction[1]) / denom
  }

  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** Parses a nutrition field. Blank means zero -- labels often omit a line. */
export function parseNumber(raw: string): number | null {
  const text = raw.trim()
  if (!text) return 0
  const n = Number(text)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}
