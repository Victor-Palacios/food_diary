/**
 * The weekly summary's numbers, as one pure function over rows already
 * fetched, so every figure in the email can be tested without a database.
 *
 * The rules are the app's own, kept deliberately identical so the email and
 * the dashboard never disagree:
 *
 *  - An unlogged day is absent, never zero. Averages cover logged days only.
 *  - Each day is scored against the target in effect on that day.
 *  - Fiber counts an unrecorded entry as zero, so its figures are a floor.
 *  - The estimated share is by calories, not by days.
 *
 * See "Weekly summary email" in the README for how the email is put together.
 */

/** A week: the email goes out on Saturday and covers Saturday to Friday. */
export const SUMMARY_DAYS = 7

const DAY_MS = 86_400_000

/** @param {string} iso @param {number} n */
export function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10)
}

/** The calendar date in a timezone, as YYYY-MM-DD. */
export function localDate(at, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at)
}

/** 0 = Sunday. */
export function weekday(iso) {
  return new Date(iso + 'T12:00:00Z').getUTCDay()
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0)

/** The target whose effective_from is the latest on or before the date. */
export function targetOn(targets, date) {
  let best = null
  for (const t of targets) {
    if (t.effective_from <= date && (!best || t.effective_from > best.effective_from)) best = t
  }
  return best
}

/**
 * @param {object} input
 * @param {Array<object>} input.entries   log_entries rows (PostgREST shape; numerics may be strings)
 * @param {Array<object>} input.targets   targets rows
 * @param {string} input.end              last day of the summary, YYYY-MM-DD
 * @param {string|null} input.firstEver   the earliest eaten_on in the whole log
 * @param {Array<{name: string, foodIds: string[]}>|null} input.meals  saved meals, or null if unavailable
 */
export function computeSummary({ entries, targets, end, firstEver, meals = null, length = SUMMARY_DAYS }) {
  const start = addDays(end, -(length - 1))
  const inWindow = entries.filter((e) => e.eaten_on >= start && e.eaten_on <= end)

  const days = Array.from({ length }, (_, i) => {
    const date = addDays(start, i)
    const es = inWindow.filter((e) => e.eaten_on === date)
    const sum = (k) => es.reduce((a, e) => a + n(e[k]), 0)
    const t = targetOn(targets, date)
    const kcal = sum('calories')
    const est = es.filter((e) => e.s_is_estimate).reduce((a, e) => a + n(e.calories), 0)
    return {
      date,
      state: es.length ? 'logged' : !firstEver || date < firstEver ? 'before' : 'missed',
      entries: es.length,
      kcal,
      est,
      measured: kcal - est,
      protein: sum('protein_g'),
      carbs: sum('carbs_g'),
      fat: sum('fat_total_g'),
      fiber: sum('fiber_g'),
      fiberEntries: es.filter((e) => e.fiber_g !== null && e.fiber_g !== undefined).length,
      ceiling: t ? n(t.calories_max) : null,
      proteinTarget: t ? n(t.protein_g) : null,
      fiberTarget: t ? n(t.fiber_g) : null,
      estimatedItems: es
        .filter((e) => e.s_is_estimate)
        .map((e) => ({ label: e.label, kcal: n(e.calories) }))
        .sort((a, b) => b.kcal - a.kcal),
    }
  })

  const logged = days.filter((d) => d.state === 'logged')
  const totalKcal = logged.reduce((a, d) => a + d.kcal, 0)

  // Consecutive logged days ending on the summary's last day.
  let run = 0
  for (let i = days.length - 1; i >= 0 && days[i].state === 'logged'; i--) run++

  const peak = logged.length ? logged.reduce((a, d) => (d.kcal > a.kcal ? d : a)) : null
  const withoutPeak = peak ? logged.filter((d) => d !== peak).map((d) => d.kcal) : []

  // Energy split from the macros themselves, 4/4/9 kcal per gram.
  const pK = logged.reduce((a, d) => a + d.protein, 0) * 4
  const cK = logged.reduce((a, d) => a + d.carbs, 0) * 4
  const fK = logged.reduce((a, d) => a + d.fat, 0) * 9
  const macroK = pK + cK + fK

  const estKcal = logged.reduce((a, d) => a + d.est, 0)

  // Foods by calories contributed. Keyed by label, which is what the log
  // shows; an entry counts as an estimate if it was filed as one.
  const byFood = new Map()
  for (const e of inWindow) {
    const f = byFood.get(e.label) ?? { label: e.label, kcal: 0, times: 0, estimate: false }
    f.kcal += n(e.calories)
    f.times += 1
    f.estimate ||= Boolean(e.s_is_estimate)
    byFood.set(e.label, f)
  }
  const topFoods = [...byFood.values()].sort((a, b) => b.kcal - a.kcal).slice(0, 8)

  // How much each saved meal's foods added, and on how many days all of them
  // were eaten together.
  const mealShares = meals
    ? meals
        .filter((m) => m.foodIds.length >= 2)
        .map((m) => {
          const ids = new Set(m.foodIds)
          const kcal = inWindow.filter((e) => ids.has(e.food_id)).reduce((a, e) => a + n(e.calories), 0)
          const fullDays = logged.filter((d) =>
            m.foodIds.every((id) => inWindow.some((e) => e.eaten_on === d.date && e.food_id === id)),
          ).length
          return { name: m.name, kcal, share: totalKcal ? kcal / totalKcal : 0, fullDays }
        })
        .filter((m) => m.kcal > 0)
        .sort((a, b) => b.kcal - a.kcal)
    : null

  const target = targetOn(targets, end)

  return {
    start,
    end,
    days,
    daysLogged: logged.length,
    missed: days.filter((d) => d.state === 'missed').map((d) => d.date),
    before: days.filter((d) => d.state === 'before').length,
    run,
    kcal: {
      mean: mean(logged.map((d) => d.kcal)),
      median: median(logged.map((d) => d.kcal)),
      meanWithoutPeak: withoutPeak.length ? mean(withoutPeak) : null,
      total: totalKcal,
      overCeiling: logged.filter((d) => d.ceiling !== null && d.kcal > d.ceiling).length,
    },
    peak,
    protein: {
      mean: mean(logged.map((d) => d.protein)),
      hit: logged.filter((d) => d.proteinTarget !== null && d.protein >= d.proteinTarget).length,
      target: target ? n(target.protein_g) : null,
    },
    fiber: {
      mean: mean(logged.map((d) => d.fiber)),
      hit: logged.filter((d) => d.fiberTarget !== null && d.fiber >= d.fiberTarget).length,
      target: target ? n(target.fiber_g) : null,
      entriesWith: inWindow.filter((e) => e.fiber_g !== null && e.fiber_g !== undefined).length,
      entries: inWindow.length,
    },
    split: macroK
      ? { protein: pK / macroK, carbs: cK / macroK, fat: fK / macroK }
      : { protein: 0, carbs: 0, fat: 0 },
    macros: {
      protein: mean(logged.map((d) => d.protein)),
      carbs: mean(logged.map((d) => d.carbs)),
      fat: mean(logged.map((d) => d.fat)),
    },
    estimated: {
      kcal: estKcal,
      share: totalKcal ? estKcal / totalKcal : 0,
      entries: inWindow.filter((e) => e.s_is_estimate).length,
      days: logged.filter((d) => d.est > 0).length,
    },
    topFoods,
    distinctFoods: byFood.size,
    entryCount: inWindow.length,
    mealShares,
    ceiling: target ? n(target.calories_max) : null,
    ceilingChanges: days.flatMap((d, i) => {
      const prev = days[i - 1]?.ceiling
      return i > 0 && prev != null && d.ceiling != null && d.ceiling !== prev
        ? [{ date: d.date, from: prev, to: d.ceiling }]
        : []
    }),
  }
}
