import { METRICS, type DailyTotals, type Metric, type NutritionInput } from './types'
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
  /** Mean per LOGGED day. Fiber is null when no day recorded it. */
  mean: NutritionInput
  /** Median per LOGGED day. Fiber is null when no day recorded it. */
  median: NutritionInput
  /** Sum across logged days. Meaningful for a single day, not for a range. */
  total: NutritionInput
  /**
   * Logged days whose fiber is fully recorded. Fiber averages cover only
   * these, so the UI can say what the figure is actually based on rather
   * than passing off a partial average as the whole picture.
   */
  fiberDaysKnown: number
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

  // Fiber is averaged only over days that actually recorded it. Folding an
  // unrecorded day in as a zero would understate the average and never say
  // so -- the same trap as counting an unlogged day as 0 calories.
  const fiberDays = inWindow.filter((d) => d.fiber_g !== null && d.fiber_g !== undefined)

  const result: Aggregate = {
    daysLogged: inWindow.length,
    daysInWindow,
    mean: { ...ZERO_NUTRITION },
    median: { ...ZERO_NUTRITION },
    total: { ...ZERO_NUTRITION },
    fiberDaysKnown: fiberDays.length,
  }

  for (const metric of METRICS) {
    const source = metric === 'fiber_g' ? fiberDays : inWindow
    const values = source.map((d) => Number(d[metric]) || 0)

    if (metric === 'fiber_g' && values.length === 0) {
      result.mean.fiber_g = null
      result.median.fiber_g = null
      result.total.fiber_g = null
      continue
    }

    result.mean[metric] = mean(values)
    result.median[metric] = median(values)
    result.total[metric] = values.reduce((a, b) => a + b, 0)
  }

  return result
}

/**
 * Sums a set of nutrition-bearing rows (log entries for one day).
 *
 * The day's fiber is known only when every row recorded it. One unrecorded
 * entry makes the day's total a partial sum, and reporting a partial sum as
 * the whole is how an average quietly drifts low.
 */
export function sumNutrition(
  rows: Array<Partial<Record<Metric, number | null>>>,
): NutritionInput {
  const out: NutritionInput = { ...ZERO_NUTRITION }
  let fiberComplete = true

  for (const row of rows) {
    for (const metric of METRICS) {
      if (metric === 'fiber_g') {
        if (row.fiber_g === null || row.fiber_g === undefined) fiberComplete = false
        else out.fiber_g = (out.fiber_g ?? 0) + (Number(row.fiber_g) || 0)
        continue
      }
      out[metric] += Number(row[metric]) || 0
    }
  }

  if (!fiberComplete) out.fiber_g = null
  return out
}

/** Scales a per-serving snapshot by a multiplier, for live preview. */
export function scale(nutrition: NutritionInput, multiplier: number): NutritionInput {
  const out: NutritionInput = { ...ZERO_NUTRITION }
  for (const metric of METRICS) {
    if (metric === 'fiber_g') {
      // Unrecorded stays unrecorded however much of it was eaten.
      out.fiber_g = nutrition.fiber_g === null ? null : (Number(nutrition.fiber_g) || 0) * multiplier
      continue
    }
    out[metric] = (Number(nutrition[metric]) || 0) * multiplier
  }
  return out
}

/** Indexes daily rows by date for O(1) table lookups. */
export function byDate(days: DailyTotals[]): Map<IsoDate, DailyTotals> {
  return new Map(days.map((d) => [d.eaten_on, d]))
}
