import { describe, expect, it } from 'vitest'

import { aggregate, mean, median, scale, sumNutrition } from './stats'
import { addDays, dateRange, daysBetween, endOfMonth, endOfWeek, startOfMonth, startOfWeek } from './dates'
import { formatMultiplier, parseMultiplier, parseNumber } from './format'
import type { DailyTotals } from './types'

/**
 * Unit tests for the pure logic. The dashboard aggregation is the reason these
 * exist: a bug there produces a plausible-looking wrong number rather than a
 * visible failure, and that number is the only output the product has.
 *
 * Run with `npm test`. Vitest is used rather than the bare Node runner so the
 * modules resolve exactly as they do in the build.
 */

function day(date: string, calories: number): DailyTotals {
  return {
    owner_id: 'o',
    eaten_on: date,
    entry_count: 1,
    fiber_entry_count: 1,
    calories,
    protein_g: calories / 10,
    carbs_g: 0,
    fat_total_g: 0,
    fat_sat_g: 0,
    fat_trans_g: 0,
    fiber_g: 0,
    has_estimate: false,
  }
}

describe('mean and median', () => {
  it('averages a simple set', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5)
  })

  it('takes the middle of an odd-length set', () => {
    expect(median([5, 1, 3])).toBe(3)
  })

  it('averages the two middles of an even-length set', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('returns 0 for an empty set rather than NaN', () => {
    expect(mean([])).toBe(0)
    expect(median([])).toBe(0)
  })
})

describe('aggregate over a 21-day block', () => {
  const start = '2026-03-01'
  const end = '2026-03-21'

  it('excludes unlogged days from the mean instead of counting them as zero', () => {
    // Three logged days at 2000 kcal inside a 21-day window. Counting the
    // other eighteen as zero would give 285.7; the correct answer is 2000.
    const days = [day('2026-03-01', 2000), day('2026-03-02', 2000), day('2026-03-03', 2000)]
    const stats = aggregate(days, start, end, 21)

    expect(stats.daysLogged).toBe(3)
    expect(stats.daysInWindow).toBe(21)
    expect(stats.mean.calories).toBe(2000)
    expect(stats.median.calories).toBe(2000)
  })

  it('reports the shortfall so the UI can say so loudly', () => {
    const stats = aggregate([day('2026-03-05', 1800)], start, end, 21)
    expect(stats.daysInWindow - stats.daysLogged).toBe(20)
  })

  it('ignores rows outside the window', () => {
    const days = [
      day('2026-02-28', 9999), // before
      day('2026-03-10', 2000),
      day('2026-03-22', 9999), // after
    ]
    const stats = aggregate(days, start, end, 21)

    expect(stats.daysLogged).toBe(1)
    expect(stats.mean.calories).toBe(2000)
  })

  it('ignores days whose entries were all deleted', () => {
    const empty = { ...day('2026-03-04', 0), entry_count: 0 }
    const stats = aggregate([empty, day('2026-03-05', 2200)], start, end, 21)

    expect(stats.daysLogged).toBe(1)
    expect(stats.mean.calories).toBe(2200)
  })

  it('separates mean from median when a day is an outlier', () => {
    const days = [
      day('2026-03-01', 2000),
      day('2026-03-02', 2000),
      day('2026-03-03', 2000),
      day('2026-03-04', 5000),
    ]
    const stats = aggregate(days, start, end, 21)

    expect(stats.mean.calories).toBe(2750)
    expect(stats.median.calories).toBe(2000)
  })

  it('returns zeros, not NaN, for a block with nothing logged', () => {
    const stats = aggregate([], start, end, 21)
    expect(stats.daysLogged).toBe(0)
    expect(stats.mean.calories).toBe(0)
    expect(stats.median.calories).toBe(0)
  })
})

describe('calendar arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
  })

  it('adds days across a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29')
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28')
  })

  it('is unaffected by a DST transition', () => {
    // 8 March 2026 is a US spring-forward date. A Date-based implementation
    // in local time can skip or repeat a day here; calendar dates must not.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2)
  })

  it('counts days between dates, signed', () => {
    expect(daysBetween('2026-03-01', '2026-03-21')).toBe(20)
    expect(daysBetween('2026-03-21', '2026-03-01')).toBe(-20)
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(0)
  })

  it('produces an inclusive 21-day range', () => {
    const range = dateRange('2026-03-01', '2026-03-21')
    expect(range.length).toBe(21)
    expect(range[0]).toBe('2026-03-01')
    expect(range[20]).toBe('2026-03-21')
  })

  it('starts weeks on Monday', () => {
    // 2026-03-15 is a Sunday.
    expect(startOfWeek('2026-03-15')).toBe('2026-03-09')
    expect(endOfWeek('2026-03-15')).toBe('2026-03-15')
    // 2026-03-16 is a Monday.
    expect(startOfWeek('2026-03-16')).toBe('2026-03-16')
    expect(endOfWeek('2026-03-16')).toBe('2026-03-22')
  })

  it('bounds a month', () => {
    expect(startOfMonth('2026-03-15')).toBe('2026-03-01')
    expect(endOfMonth('2026-03-15')).toBe('2026-03-31')
  })

  it('rejects a malformed date rather than guessing', () => {
    expect(() => addDays('not-a-date', 1)).toThrow()
  })
})

describe('multiplier rendering and parsing', () => {
  it('renders natural fractions as glyphs', () => {
    expect(formatMultiplier(0.5)).toBe('½x')
    expect(formatMultiplier(1.5)).toBe('1½x')
    expect(formatMultiplier(0.25)).toBe('¼x')
    expect(formatMultiplier(2.75)).toBe('2¾x')
  })

  it('renders whole numbers plainly', () => {
    expect(formatMultiplier(1)).toBe('1x')
    expect(formatMultiplier(3)).toBe('3x')
  })

  it('falls back to a decimal when no glyph fits', () => {
    expect(formatMultiplier(1.75)).toBe('1¾x')
    expect(formatMultiplier(1.2)).toBe('1.2x')
  })

  it('parses decimals', () => {
    expect(parseMultiplier('1.75')).toBe(1.75)
    expect(parseMultiplier('0.25')).toBe(0.25)
  })

  it('parses fractions and mixed numbers, which is what packets print', () => {
    expect(parseMultiplier('1/2')).toBe(0.5)
    expect(parseMultiplier('3/4')).toBe(0.75)
    expect(parseMultiplier('1 1/2')).toBe(1.5)
  })

  it('rejects unusable input instead of producing NaN', () => {
    expect(parseMultiplier('')).toBe(null)
    expect(parseMultiplier('abc')).toBe(null)
    expect(parseMultiplier('1/0')).toBe(null)
  })
})

describe('nutrition field parsing', () => {
  it('treats blank as zero, because labels omit lines', () => {
    expect(parseNumber('')).toBe(0)
    expect(parseNumber('   ')).toBe(0)
  })

  it('rejects negatives and nonsense', () => {
    expect(parseNumber('-5')).toBe(null)
    expect(parseNumber('abc')).toBe(null)
  })

  it('accepts decimals', () => {
    expect(parseNumber('1.5')).toBe(1.5)
  })
})

/**
 * Fiber is the one metric that is routinely not recorded, so NULL means
 * "unknown" and must never be averaged in as a zero. This is the same rule
 * as excluding unlogged days, applied one level down.
 */
describe('fiber may be unrecorded', () => {
  const start = '2026-03-01'
  const end = '2026-03-21'

  /**
   * `fiber` is the day's total as the view reports it -- the entries that
   * recorded fiber, summed. `covered` is how many of the day's entries that
   * was, which is what separates a mean from a floor.
   */
  function withFiber(
    date: string,
    calories: number,
    fiber: number,
    covered = 1,
  ): DailyTotals {
    return { ...day(date, calories), fiber_g: fiber, fiber_entry_count: covered }
  }

  it('averages fiber over every logged day, counting unrecorded as zero', () => {
    // Withholding this was the bug: with fiber on almost nothing, no day
    // qualified as fully recorded and the figure never appeared at all.
    const days = [
      withFiber('2026-03-01', 2000, 20),
      withFiber('2026-03-02', 2000, 20),
      withFiber('2026-03-03', 2000, 0, 0),
    ]
    const stats = aggregate(days, start, end, 21)

    expect(stats.daysLogged).toBe(3)
    expect(stats.mean.fiber_g).toBeCloseTo(13.33, 2)
    expect(stats.total.fiber_g).toBe(40)
    // Two of the three days recorded fiber on every entry, so the mean is a
    // floor rather than a measurement and the UI has to say so.
    expect(stats.fiberDaysKnown).toBe(2)
    // Calories are unaffected -- all three days recorded those.
    expect(stats.mean.calories).toBe(2000)
  })

  it('still reports a figure when no day recorded any fiber', () => {
    const days = [
      withFiber('2026-03-01', 2000, 0, 0),
      withFiber('2026-03-02', 2000, 0, 0),
    ]
    const stats = aggregate(days, start, end, 21)

    expect(stats.fiberDaysKnown).toBe(0)
    expect(stats.mean.fiber_g).toBe(0)
    expect(stats.total.fiber_g).toBe(0)
  })

  it('counts a day fully covered only when every entry recorded fiber', () => {
    // The real case: six entries, two carrying fiber. 21 g is real and must
    // show, but the day is not fully covered.
    const partial = { ...day('2026-03-01', 2027), fiber_g: 21, entry_count: 6, fiber_entry_count: 2 }
    const stats = aggregate([partial], start, end, 21)
    expect(stats.total.fiber_g).toBe(21)
    expect(stats.fiberDaysKnown).toBe(0)
  })
})

describe('summing a day of entries', () => {
  it('sums the fiber that was recorded and reports the coverage', () => {
    const total = sumNutrition([
      { calories: 100, fiber_g: 3 },
      { calories: 200, fiber_g: null },
    ])
    expect(total.calories).toBe(300)
    // The 3 g is real and shows; the caller says it covers 1 of 2 entries.
    expect(total.fiber_g).toBe(3)
    expect(total.fiberEntryCount).toBe(1)
  })

  it('sums fiber when every entry recorded it', () => {
    const total = sumNutrition([
      { calories: 100, fiber_g: 3 },
      { calories: 200, fiber_g: 4 },
    ])
    expect(total.fiber_g).toBe(7)
    expect(total.fiberEntryCount).toBe(2)
  })

  it('reports no coverage when nothing recorded fiber', () => {
    const total = sumNutrition([{ calories: 100, fiber_g: null }])
    expect(total.fiber_g).toBe(0)
    expect(total.fiberEntryCount).toBe(0)
  })
})

describe('scaling by a multiplier', () => {
  it('leaves unrecorded fiber unrecorded', () => {
    const out = scale(
      { calories: 100, protein_g: 10, carbs_g: 5, fat_total_g: 2, fat_sat_g: 1, fat_trans_g: 0, fiber_g: null },
      2,
    )
    expect(out.calories).toBe(200)
    expect(out.fiber_g).toBeNull()
  })

  it('scales fiber when it is known', () => {
    const out = scale(
      { calories: 100, protein_g: 10, carbs_g: 5, fat_total_g: 2, fat_sat_g: 1, fat_trans_g: 0, fiber_g: 3 },
      2,
    )
    expect(out.fiber_g).toBe(6)
  })
})
