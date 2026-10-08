import { describe, expect, it } from 'vitest'
import nodemailer from 'nodemailer'
import { addDays, computeSummary } from './compute.mjs'
import { METHOD, columnRuns, escapeHtml, renderEmail, renderText, subject } from './render.mjs'
import { buildMessage, shouldSend, utcOffsetHours } from './send.mjs'

/**
 * The weekly email. Synthetic rows only: the repository is public, so real
 * log data never goes in a test.
 */

const END = '2026-10-09' // a Friday
const T_OLD = { effective_from: '2026-09-01', calories_max: '2300', protein_g: '140', fiber_g: '15' }
const T_NEW = { effective_from: '2026-09-28', calories_max: '2200', protein_g: '140', fiber_g: '28' }

let id = 0
function entry(eaten_on, calories, extra = {}) {
  id += 1
  return {
    id: `e${id}`,
    eaten_on,
    eaten_at: `${eaten_on}T15:00:00Z`,
    label: 'oats',
    food_id: 'f-oats',
    calories: String(calories),
    protein_g: '10',
    carbs_g: '20',
    fat_total_g: '5',
    fiber_g: null,
    s_is_estimate: false,
    ...extra,
  }
}

describe('when the scheduled email goes out', () => {
  // Saturday 10 October 2026 is in daylight time; 7 November is not.
  const SUMMER_15 = new Date('2026-10-10T15:00:00Z')
  const SUMMER_16 = new Date('2026-10-10T16:00:00Z')
  const WINTER_15 = new Date('2026-11-07T15:00:00Z')
  const WINTER_16 = new Date('2026-11-07T16:00:00Z')

  it('knows California is UTC-7 in summer and UTC-8 in winter', () => {
    expect(utcOffsetHours(SUMMER_15, 'America/Los_Angeles')).toBe(-7)
    expect(utcOffsetHours(WINTER_16, 'America/Los_Angeles')).toBe(-8)
  })

  it('sends from the 15:00 UTC schedule in summer and skips the 16:00 one', () => {
    expect(shouldSend({ event: 'schedule', schedule: '0 15 * * 6', now: SUMMER_15 }).send).toBe(true)
    expect(shouldSend({ event: 'schedule', schedule: '0 16 * * 6', now: SUMMER_16 }).send).toBe(false)
  })

  it('sends from the 16:00 UTC schedule in winter and skips the 15:00 one', () => {
    expect(shouldSend({ event: 'schedule', schedule: '0 16 * * 6', now: WINTER_16 }).send).toBe(true)
    expect(shouldSend({ event: 'schedule', schedule: '0 15 * * 6', now: WINTER_15 }).send).toBe(false)
  })

  it('still sends once when GitHub starts the run late', () => {
    // Decided by which schedule fired, not the clock: a 15:00 run that only
    // starts at 16:40 must neither be dropped nor joined by the 16:00 one.
    const late = new Date('2026-10-10T16:40:00Z')
    expect(shouldSend({ event: 'schedule', schedule: '0 15 * * 6', now: late }).send).toBe(true)
    expect(shouldSend({ event: 'schedule', schedule: '0 16 * * 6', now: late }).send).toBe(false)
  })

  it('always sends from a manual run', () => {
    expect(shouldSend({ event: 'workflow_dispatch', schedule: undefined, now: SUMMER_16 }).send).toBe(true)
  })
})

describe('the numbers', () => {
  const start = addDays(END, -6)

  it('covers the 7 days ending on the last day, Saturday to Friday', () => {
    const s = computeSummary({ entries: [], targets: [T_OLD], end: END, firstEver: start })
    expect(s.start).toBe('2026-10-03')
    expect(s.days).toHaveLength(7)
    expect(s.days.at(-1).date).toBe(END)
  })

  it('leaves unlogged days out of the averages instead of counting them as zero', () => {
    const s = computeSummary({
      entries: [entry(END, 2000), entry(addDays(END, -1), 2200)],
      targets: [T_NEW],
      end: END,
      firstEver: '2026-09-01',
    })
    expect(s.daysLogged).toBe(2)
    expect(s.kcal.mean).toBe(2100)
    expect(s.kcal.median).toBe(2100)
  })

  it('marks days before the first entry as before, not missed', () => {
    const first = addDays(start, 2)
    const s = computeSummary({ entries: [entry(first, 2000), entry(END, 2000)], targets: [T_OLD], end: END, firstEver: first })
    expect(s.before).toBe(2)
    expect(s.missed).toHaveLength(7 - 2 - 2)
    expect(s.days[0].state).toBe('before')
    expect(s.days[3].state).toBe('missed')
  })

  it('scores each day against the target in effect that day', () => {
    // 2,250 is under the old 2,300 ceiling and over the new 2,200 one.
    const T_MID = { ...T_NEW, effective_from: '2026-10-06' }
    const s = computeSummary({
      entries: [entry('2026-10-05', 2250), entry('2026-10-06', 2250)],
      targets: [T_OLD, T_MID],
      end: END,
      firstEver: '2026-10-05',
    })
    expect(s.kcal.overCeiling).toBe(1)
    expect(s.ceilingChanges).toEqual([{ date: '2026-10-06', from: 2300, to: 2200 }])
    expect(s.ceiling).toBe(2200)
  })

  it('measures the estimated share in calories, not days', () => {
    const s = computeSummary({
      entries: [
        entry(END, 100, { s_is_estimate: true, label: 'banana guess' }),
        entry(END, 1900),
        entry(addDays(END, -1), 1800, { s_is_estimate: true, label: 'dinner guess' }),
        entry(addDays(END, -1), 200),
      ],
      targets: [T_NEW],
      end: END,
      firstEver: '2026-09-01',
    })
    expect(s.estimated.kcal).toBe(1900)
    expect(s.estimated.share).toBeCloseTo(1900 / 4000, 6)
    expect(s.estimated.days).toBe(2)
    expect(s.estimated.entries).toBe(2)
  })

  it('counts the current run of logged days up to the end', () => {
    const entries = [0, 1, 2, 4].map((back) => entry(addDays(END, -back), 2000))
    const s = computeSummary({ entries, targets: [T_NEW], end: END, firstEver: '2026-09-01' })
    expect(s.run).toBe(3)
  })

  it('names the biggest day and what was estimated in it', () => {
    const s = computeSummary({
      entries: [
        entry(END, 2000),
        entry('2026-10-07', 700),
        entry('2026-10-07', 1600, { s_is_estimate: true, label: 'mole and churros' }),
        entry('2026-10-07', 859, { s_is_estimate: true, label: 'fried rice' }),
      ],
      targets: [T_NEW],
      end: END,
      firstEver: '2026-09-01',
    })
    expect(s.peak.date).toBe('2026-10-07')
    expect(s.peak.kcal).toBe(3159)
    expect(s.peak.estimatedItems.map((i) => i.label)).toEqual(['mole and churros', 'fried rice'])
    expect(s.kcal.meanWithoutPeak).toBe(2000)
  })

  it('treats fiber as a floor and reports how many entries recorded it', () => {
    const s = computeSummary({
      entries: [entry(END, 500, { fiber_g: '8' }), entry(END, 500)],
      targets: [T_NEW],
      end: END,
      firstEver: '2026-09-01',
    })
    expect(s.fiber.mean).toBe(8)
    expect(s.fiber.entriesWith).toBe(1)
    expect(s.fiber.entries).toBe(2)
  })

  it('works out what share a saved meal’s foods made up', () => {
    const day1 = END, day2 = addDays(END, -1)
    const s = computeSummary({
      entries: [
        entry(day1, 150, { food_id: 'oats', label: 'oats' }),
        entry(day1, 160, { food_id: 'fruit', label: 'fruit' }),
        entry(day1, 690, { food_id: 'wrap', label: 'wrap' }),
        entry(day2, 160, { food_id: 'fruit', label: 'fruit' }), // only half the meal
        entry(day2, 840, { food_id: 'wrap', label: 'wrap' }),
      ],
      targets: [T_NEW],
      end: END,
      firstEver: '2026-09-01',
      meals: [{ name: 'Usual breakfast', foodIds: ['oats', 'fruit'] }],
    })
    expect(s.mealShares[0].kcal).toBe(470)
    expect(s.mealShares[0].share).toBeCloseTo(470 / 2000, 6)
    expect(s.mealShares[0].fullDays).toBe(1)
    expect(s.topFoods[0].label).toBe('wrap')
  })

  it('leaves the meal callout out when meals are not set up yet', () => {
    const s = computeSummary({ entries: [entry(END, 2000)], targets: [T_NEW], end: END, firstEver: END, meals: null })
    expect(s.mealShares).toBeNull()
    expect(renderEmail(s)).not.toContain('foods</b> made up')
  })
})

describe('the email', () => {
  const base = () =>
    computeSummary({
      entries: [entry(END, 2400, { s_is_estimate: true, label: 'plate' }), entry(addDays(END, -1), 2000)],
      targets: [T_NEW],
      end: END,
      firstEver: '2026-09-01',
    })

  it('escapes food names, which are user data', () => {
    const s = computeSummary({
      entries: [entry(END, 2000, { label: '<img src=x onerror=alert(1)>' })],
      targets: [T_NEW],
      end: END,
      firstEver: END,
    })
    const html = renderEmail(s)
    expect(html).not.toContain('<img src=x')
    expect(html).toContain(escapeHtml('<img src=x onerror=alert(1)>'))
  })

  it('draws every chart column to the full height, with the ceiling across it', () => {
    for (const d of base().days) {
      const runs = columnRuns(d, 3000)
      expect(runs.reduce((a, r) => a + r.h, 0)).toBe(150)
      if (d.ceiling !== null) expect(runs.some((r) => r.color === 'line')).toBe(true)
    }
  })

  it('stacks the estimate on top of the measured part with a gap', () => {
    const day = { state: 'logged', kcal: 2000, measured: 1000, est: 1000, ceiling: null }
    const colors = columnRuns(day, 3000).map((r) => r.color)
    expect(colors).toEqual(['empty', 'estimated', 'gap', 'measured'])
  })

  it('includes the method note and leaves out the DEXA section', () => {
    const html = renderEmail(base())
    expect(html).toContain('How this summary is made')
    for (const line of METHOD) expect(html).toContain(escapeHtml(line))
    expect(html).not.toMatch(/DEXA/i)
  })

  it('says so plainly when nothing was logged', () => {
    const s = computeSummary({ entries: [], targets: [T_NEW], end: END, firstEver: '2026-09-01' })
    expect(renderEmail(s)).toContain('Nothing logged')
    expect(renderText(s)).toContain('nothing logged')
  })

  it('assembles into a real message with both parts', async () => {
    const s = base()
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
    const info = await transport.sendMail(buildMessage(s, { from: 'me@example.com', to: 'me@example.com' }))
    const raw = info.message.toString()
    expect(raw).toContain('Content-Type: text/html')
    expect(raw).toContain('Content-Type: text/plain')
    expect(info.envelope.to).toEqual(['me@example.com'])
    expect(subject(s)).toBe('Food Log: Oct 3 – Oct 9 · median 2,200 kcal/day')
  })
})
