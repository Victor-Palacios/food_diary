import { METRICS, type DailyTotals, type Metric, type Nutrition } from './types'
import { ZERO_NUTRITION } from './types'
import type { IsoDate } from './dates'

/**
 * Aggregation for the dashboard.
 *
 * The one rule that matters: an unlogged day is ABSENT, never zero. A missed
 * day read as a 0-calorie day drags a 21-day mean down by roughly 110 kcal --
 * the same size as the adjustment step the whole loop turns on. That would
 * make the app lie about the only number it exists to produce, so every
 * function here takes only the days that actually have entries, and reports
 * the count separately so the UI can say how many are missing.
 */

export interface Aggregate {
  /** Days in the window that have at least one entry. */
  daysLogged: number
  /** Total days in the window, logged or not. */
  daysInWindow: number
  /** Mean per LOGGED day. */
  mean: Nutrition
  /** Median per LOGGED day. */
  median: Nutrition
  /** Sum across logged days. Meaningful for a single day, not for a range. */
  total: Nutrition
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Aggregates the logged days inside a window.
 *
 * `days` may contain rows outside the window; they are filtered out here so
 * callers can pass one fetched range and slice it several ways.
 */
export function aggregate(
  days: DailyTotals[],
  windowStart: IsoDate,
  windowEnd: IsoDate,
  daysInWindow: number,
): Aggregate {
  const inWindow = days.filter(
    (d) => d.eaten_on >= windowStart && d.eaten_on <= windowEnd && d.entry_count > 0,
  )

  const result: Aggregate = {
    daysLogged: inWindow.length,
    daysInWindow,
    mean: { ...ZERO_NUTRITION },
    median: { ...ZERO_NUTRITION },
    total: { ...ZERO_NUTRITION },
  }

  for (const metric of METRICS) {
    const values = inWindow.map((d) => Number(d[metric]) || 0)
    result.mean[metric] = mean(values)
    result.median[metric] = median(values)
    result.total[metric] = values.reduce((a, b) => a + b, 0)
  }

  return result
}

/** Sums a set of nutrition-bearing rows (log entries for one day). */
export function sumNutrition(rows: Array<Partial<Record<Metric, number>>>): Nutrition {
  const out = { ...ZERO_NUTRITION }
  for (const row of rows) {
    for (const metric of METRICS) out[metric] += Number(row[metric]) || 0
  }
  return out
}

/** Scales a per-serving snapshot by a multiplier, for live preview. */
export function scale(nutrition: Nutrition, multiplier: number): Nutrition {
  const out = { ...ZERO_NUTRITION }
  for (const metric of METRICS) out[metric] = (Number(nutrition[metric]) || 0) * multiplier
  return out
}

/** Indexes daily rows by date for O(1) table lookups. */
export function byDate(days: DailyTotals[]): Map<IsoDate, DailyTotals> {
  return new Map(days.map((d) => [d.eaten_on, d]))
}
