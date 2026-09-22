import { METRICS, type DailyTotals, type Metric, type Nutrition, type NutritionInput } from './types'
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
  /** Mean per LOGGED day. Fiber is null only if the view predates 0003. */
  mean: NutritionInput
  /** Median per LOGGED day. */
  median: NutritionInput
  /** Sum across logged days. Meaningful for a single day, not for a range. */
  total: NutritionInput
  /**
   * Logged days where every entry recorded fiber.
   *
   * Fiber is averaged over all logged days, counting an unrecorded entry as
   * zero, so there is always a figure to show. This says how much of the
   * window that figure actually covers, which is the difference between a
   * mean and a floor -- the UI reports it next to the number.
   */
  fiberDaysKnown: number
  /**
   * True when `daily_totals` is still the pre-0003 view, which reports NULL
   * for a day that recorded fiber on only some entries. The real sum is not
   * in the response at all, so the figure is genuinely unavailable and the UI
   * shows a dash: coercing that NULL to 0 would claim a zero on a day with
   * 21 g in it, which is the exact confusion this change set out to fix.
   *
   * Goes false by itself once the migration is applied.
   */
  fiberUnavailable: boolean
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

  // Fiber is averaged over every logged day, counting what was not recorded
  // as zero. Restricting it to fully-recorded days was more defensible in
  // principle and useless in practice: with 3 of 152 foods carrying a fiber
  // figure, no day qualified, so the dashboard showed a dash and 21 g of real
  // data was invisible. A floor you can see beats a mean you cannot.
  //
  // The number is reported with its coverage rather than on its own, so it is
  // read as "at least this much" where that is what it means.
  const fiberDays = inWindow.filter((d) => d.fiber_entry_count >= d.entry_count)

  // A NULL day fiber alongside entries that did record some means the old
  // view is still in place: it withheld the partial sum, so the number is not
  // recoverable from this response. A day where nothing recorded fiber is
  // NULL there too, but its true total is 0, so it is not ambiguous.
  const fiberUnavailable = inWindow.some(
    (d) => (d.fiber_g === null || d.fiber_g === undefined) && d.fiber_entry_count > 0,
  )

  const result: Aggregate = {
    daysLogged: inWindow.length,
    daysInWindow,
    mean: { ...ZERO_NUTRITION },
    median: { ...ZERO_NUTRITION },
    total: { ...ZERO_NUTRITION },
    fiberDaysKnown: fiberDays.length,
    fiberUnavailable,
  }

  for (const metric of METRICS) {
    if (metric === 'fiber_g' && fiberUnavailable) {
      result.mean.fiber_g = null
      result.median.fiber_g = null
      result.total.fiber_g = null
      continue
    }

    const values = inWindow.map((d) => Number(d[metric]) || 0)

    result.mean[metric] = mean(values)
    result.median[metric] = median(values)
    result.total[metric] = values.reduce((a, b) => a + b, 0)
  }

  return result
}

/**
 * Sums a set of nutrition-bearing rows (log entries for one day).
 *
 * Fiber sums the rows that recorded it and counts the rest as zero, matching
 * the `daily_totals` view. `fiberEntryCount` is returned alongside rather than
 * folded in, because a total covering 2 of 6 entries is a floor, not a
 * measurement, and only the caller can say that next to the figure.
 */
export function sumNutrition(
  rows: Array<Partial<Record<Metric, number | null>>>,
): Nutrition & { fiberEntryCount: number } {
  const out: Nutrition = { ...ZERO_NUTRITION }
  let fiberEntryCount = 0

  for (const row of rows) {
    for (const metric of METRICS) {
      if (metric === 'fiber_g') {
        if (row.fiber_g === null || row.fiber_g === undefined) continue
        fiberEntryCount += 1
        out.fiber_g += Number(row.fiber_g) || 0
        continue
      }
      out[metric] += Number(row[metric]) || 0
    }
  }

  return { ...out, fiberEntryCount }
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
