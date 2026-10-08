/**
 * Renders a computed summary as an email.
 *
 * Email is a hostile medium for a chart: no JavaScript, no web fonts, and
 * Gmail drops SVG entirely. So everything here is tables and inline styles,
 * and the daily chart is built from stacked table-cell divs. It is a fixed
 * light design with explicit colors, because mail clients invert dark themes
 * unpredictably.
 *
 * Every label from the log is escaped: food names are user data.
 */

const C = {
  bg: '#f3f5f8',
  surface: '#ffffff',
  surface2: '#eef1f5',
  border: '#dde2ea',
  text: '#10151c',
  dim: '#4a5566',
  faint: '#687384',
  accent: '#15803d',
  warn: '#a15c07',
  measured: '#2a78d6',
  estimated: '#eb6834',
  ceiling: '#4a5566',
}
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const fmt = (v) => Math.round(v).toLocaleString('en-US')
const pct = (f) => {
  if (f <= 0) return '0%'
  if (f >= 1) return '100%'
  const p = Math.round(f * 100)
  return p < 1 ? '<1%' : p > 99 ? '>99%' : `${p}%`
}
const dateLabel = (iso, opts) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...opts })
export const short = (iso) => dateLabel(iso, { month: 'short', day: 'numeric' })
export const long = (iso) => dateLabel(iso, { weekday: 'short', month: 'short', day: 'numeric' })
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

function card(inner, extra = '') {
  return `<tr><td style="padding:0 0 14px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.surface};border:1px solid ${C.border};border-radius:14px;${extra}"><tr><td style="padding:18px">${inner}</td></tr></table></td></tr>`
}
const h2 = (t) => `<div style="font-size:18px;font-weight:700;color:${C.text};margin:0 0 4px 0">${t}</div>`
const sub = (t) => `<div style="font-size:13.5px;color:${C.dim};line-height:1.45;margin:0 0 12px 0">${t}</div>`
const key = (color, label, line = false) =>
  `<span style="display:inline-block;margin:0 14px 4px 0;font-size:12.5px;color:${C.dim};white-space:nowrap"><span style="display:inline-block;width:12px;height:${line ? 2 : 12}px;background:${color};border-radius:${line ? 1 : 3}px;vertical-align:middle;margin-right:6px"></span>${label}</span>`

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

const CHART_H = 150

/**
 * One day's column, top to bottom, as solid runs of color. The ceiling line
 * spans the whole cell so it reads as one line across the chart; bar runs
 * are a block centred in it, wider when there are fewer days. The estimated part sits on top of the
 * measured part with a 2px gap, matching the app.
 */
export function columnRuns(day, yMax) {
  const px = (v) => Math.round((v / yMax) * CHART_H)
  const logged = day.state === 'logged'
  const m = logged ? px(day.measured) : 0
  const k = logged ? px(day.kcal) : 0
  const hasEst = logged && day.est > 0 && k - m > 2
  const c = day.ceiling === null ? null : px(day.ceiling)

  const stops = new Set([0, CHART_H, m, k])
  if (hasEst) stops.add(m + 2)
  if (c !== null) { stops.add(Math.max(0, c - 1)); stops.add(Math.min(CHART_H, c + 1)) }
  if (day.state === 'missed') stops.add(3)
  const sorted = [...stops].filter((s) => s >= 0 && s <= CHART_H).sort((a, b) => a - b)

  // Measured from the baseline (0) upward.
  const colorAt = (y) => {
    if (c !== null && y >= c - 1 && y < c + 1) return 'line'
    if (logged && y < m) return 'measured'
    if (hasEst && y >= m && y < m + 2) return 'gap'
    if (logged && y < k) return 'estimated'
    if (day.state === 'missed' && y < 3) return 'missed'
    return 'empty'
  }

  const runs = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const h = sorted[i + 1] - sorted[i]
    if (h <= 0) continue
    const color = colorAt((sorted[i] + sorted[i + 1]) / 2)
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.h += h
    else runs.push({ color, h })
  }
  return runs.reverse() // top first, for rendering
}

function chart(s) {
  const peakKcal = s.peak ? s.peak.kcal : 0
  const yMax = Math.max(3000, Math.ceil((Math.max(peakKcal, s.ceiling ?? 0) + 250) / 500) * 500)
  const width = (100 / s.days.length).toFixed(3) + '%'
  const barW = s.days.length <= 7 ? 28 : 12

  const cols = s.days.map((d) => {
    const runs = columnRuns(d, yMax)
    const topBar = runs.findIndex((r) => r.color === 'measured' || r.color === 'estimated')
    const cellBg = d.state === 'before' ? C.surface2 : 'transparent'
    const inner = runs.map((r, i) => {
      const radius = i === topBar ? 'border-radius:3px 3px 0 0;' : ''
      if (r.color === 'line') return `<div style="height:${r.h}px;line-height:${r.h}px;font-size:0;background:${C.ceiling}"></div>`
      const fill = { measured: C.measured, estimated: C.estimated, missed: C.warn }[r.color]
      if (!fill) return `<div style="height:${r.h}px;line-height:${r.h}px;font-size:0"></div>`
      return `<div style="height:${r.h}px;line-height:${r.h}px;font-size:0"><div style="width:${barW}px;height:${r.h}px;margin:0 auto;background:${fill};${radius}"></div></div>`
    }).join('')
    return `<td valign="bottom" style="width:${width};padding:0;background:${cellBg}">${inner}</td>`
  }).join('')

  const peakRow = s.days.map((d) => `<td align="center" style="padding:0 0 3px 0;font-size:10.5px;font-weight:700;color:${C.text};white-space:nowrap">${s.peak && d.date === s.peak.date ? fmt(d.kcal) : ''}</td>`).join('')
  const dayRow = s.days.map((d) =>
    `<td align="center" style="padding:5px 0 0 0;font-size:11px;line-height:1.3;color:${C.dim}"><b>${dateLabel(d.date, { weekday: 'short' })}</b><br>${short(d.date)}</td>`,
  ).join('')

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;border-bottom:1px solid ${C.border}"><tr>${peakRow}</tr><tr>${cols}</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed"><tr>${dayRow}</tr></table>
<div style="font-size:11.5px;color:${C.faint};margin:6px 0 0 0">The scale runs to ${fmt(yMax)} kcal.</div>`
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function hero(s) {
  const fig = (v, k, note) => `<td width="50%" valign="top" style="padding:0 8px 0 0"><div style="font-size:44px;font-weight:700;line-height:1;color:${C.text};letter-spacing:-1px">${v}</div><div style="font-size:11.5px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${C.dim};margin-top:6px">${k}</div><div style="font-size:12.5px;color:${C.faint};margin-top:2px">${note}</div></td>`
  const withoutPeak = s.peak && s.kcal.meanWithoutPeak !== null && Math.abs(s.kcal.mean - s.kcal.meanWithoutPeak) >= 25
    ? `${fmt(s.kcal.meanWithoutPeak)} without ${short(s.peak.date)}`
    : '&nbsp;'

  const cells = s.days.map((d) => {
    const style = {
      logged: `background:${C.accent}`,
      missed: `background:${C.surface};border:1.5px solid ${C.warn}`,
      before: `background:${C.surface2}`,
    }[d.state]
    return `<td style="padding:0 1.5px"><div style="height:18px;border-radius:4px;${style};box-sizing:border-box"></div></td>`
  }).join('')

  const runText = s.run >= 2 ? `${s.run} days in a row, up to ${short(s.end)}` : ''
  const notes = [
    s.missed.length ? `Missed: ${s.missed.map(long).join(', ')}.` : 'Nothing missed.',
    s.before ? `${plural(s.before, 'day')} came before your first entry.` : '',
  ].filter(Boolean).join(' ')

  return card(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${fig(fmt(s.kcal.median), 'median kcal / day', 'The steadier of the two')}
      ${fig(fmt(s.kcal.mean), 'mean kcal / day', withoutPeak)}
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>
      <td style="font-size:15px;font-weight:700;color:${C.text}">${s.daysLogged} of ${s.days.length} days logged</td>
      <td align="right" style="font-size:12.5px;color:${C.dim}">${runText}</td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;margin-top:8px"><tr>${cells}</tr></table>
    <div style="margin-top:8px">${key(C.accent, 'Logged')}${s.missed.length ? key(C.warn, 'Missed') : ''}${s.before ? key(C.surface2, 'Before you started') : ''}</div>
    <div style="font-size:12.5px;color:${C.dim};margin-top:2px">${notes}</div>`)
}

function chartCard(s) {
  const change = s.ceilingChanges.length
    ? ` It moved ${s.ceilingChanges.map((c) => `from ${fmt(c.from)} to ${fmt(c.to)} on ${short(c.date)}`).join(', then ')}.`
    : s.ceiling !== null ? ` It was ${fmt(s.ceiling)} throughout.` : ''

  let callout = ''
  if (s.peak) {
    const p = s.peak
    const over = p.ceiling !== null && p.kcal > p.ceiling ? `, ${fmt(p.kcal - p.ceiling)} over the ceiling` : ''
    const items = p.estimatedItems.slice(0, 2).map((i) => `${escapeHtml(i.label)} (${fmt(i.kcal)})`)
    const est = p.est > 0 ? ` ${fmt(p.est)} of it was estimated: ${items.join(' and ')}${p.estimatedItems.length > 2 ? ' and more' : ''}.` : ''
    callout = `<div style="margin-top:14px;padding-left:12px;border-left:2px solid ${C.estimated};font-size:13.5px;color:${C.dim};line-height:1.45"><b style="color:${C.text}">${long(p.date)} was the biggest day: ${fmt(p.kcal)} kcal</b>${over}.${est}</div>`
  }

  return card(`${h2('Every day this week')}${sub(`Calories per day against the ceiling in effect that day.${change}`)}
    <div style="margin:0 0 10px 0">${key(C.measured, 'From a label or your own figures')}${key(C.estimated, 'Estimated')}${key(C.ceiling, 'Ceiling', true)}</div>
    ${chart(s)}${callout}`)
}

function tiles(s) {
  const status = (ok, text) => `<div style="font-size:12.5px;font-weight:700;color:${ok ? C.accent : C.warn};margin-top:6px">${ok ? '&#10003;' : '!'} ${text}</div>`
  const tile = (k, v, unit, body) => `<td width="50%" valign="top" style="padding:0 6px 12px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.surface};border:1px solid ${C.border};border-radius:14px"><tr><td style="padding:16px"><div style="font-size:13px;font-weight:600;color:${C.dim}">${k}</div><div style="font-size:28px;font-weight:700;color:${C.text};line-height:1.15;margin-top:4px">${v}<span style="font-size:14px;font-weight:600;color:${C.dim};margin-left:3px">${unit}</span></div><div style="font-size:13px;color:${C.dim};line-height:1.45;margin-top:6px">${body}</div></td></tr></table></td>`

  const p = s.protein
  const proteinStatus = p.target === null ? '' : p.mean >= p.target ? status(true, 'At or above target') : status(false, `${fmt(p.target - p.mean)} g short on average`)
  const f = s.fiber
  const fiberStatus = f.target === null ? '' : status(f.mean >= f.target, f.mean >= f.target ? 'Above target' : `${fmt(f.target - f.mean)} g short on average`)
  const e = s.estimated
  const sp = s.split
  const bar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;margin-top:8px"><tr><td style="width:${(sp.protein * 100).toFixed(2)}%;height:10px;background:${C.text};font-size:0">&nbsp;</td><td style="width:${(sp.carbs * 100).toFixed(2)}%;height:10px;background:${C.dim};font-size:0;border-left:2px solid ${C.surface}">&nbsp;</td><td style="width:${(sp.fat * 100).toFixed(2)}%;height:10px;background:${C.faint};font-size:0;border-left:2px solid ${C.surface}">&nbsp;</td></tr></table>`

  return `<tr><td style="padding:0 0 2px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${tile('Protein', fmt(p.mean), 'g / day', `${p.target !== null ? `Target ${fmt(p.target)} g. ` : ''}Reached on <b style="color:${C.text}">${p.hit} of ${s.daysLogged}</b> days.${proteinStatus}`)}
    ${tile('Fiber', `${fmt(f.mean)}+`, 'g / day', `${f.target !== null ? `Target ${fmt(f.target)} g. ` : ''}Reached on <b style="color:${C.text}">${f.hit} of ${s.daysLogged}</b> days. A floor: ${f.entriesWith} of ${f.entries} entries recorded fiber.${fiberStatus}`)}
  </tr><tr>
    ${tile('Estimated', pct(e.share), 'of calories', e.kcal > 0 ? `<b style="color:${C.text}">${fmt(e.kcal)} kcal</b> from ${plural(e.entries, 'estimated entry', 'estimated entries')} on ${plural(e.days, 'day')}. Everything else came from labels or your own figures.` : 'None of these calories were estimated.')}
    ${tile('Energy split', pct(sp.carbs), 'from carbs', `${bar}<div style="margin-top:6px">Protein <b style="color:${C.text}">${pct(sp.protein)}</b> &nbsp;Carbs <b style="color:${C.text}">${pct(sp.carbs)}</b> &nbsp;Fat <b style="color:${C.text}">${pct(sp.fat)}</b></div><div style="margin-top:4px">Averages ${fmt(s.macros.protein)} g protein, ${fmt(s.macros.carbs)} g carbs, ${fmt(s.macros.fat)} g fat a day.</div>`)}
  </tr></table></td></tr>`
}

function foodsCard(s) {
  const max = s.topFoods[0]?.kcal || 1
  const rows = s.topFoods.map((f) => `<tr><td style="padding:0 0 11px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:14px;font-weight:600;color:${C.text}">${escapeHtml(f.label)}${f.estimate ? ` <span style="font-size:11px;font-weight:700;color:${C.text};border:1px solid ${C.estimated};border-radius:6px;padding:0 5px">estimate</span>` : ''}</td>
      <td align="right" style="font-size:13px;color:${C.dim};white-space:nowrap;padding-left:10px"><b style="color:${C.text}">${fmt(f.kcal)}</b> kcal &middot; ${f.times}&times;</td>
    </tr></table>
    <div style="height:10px;width:${((f.kcal / max) * 100).toFixed(1)}%;background:${f.estimate ? C.estimated : C.measured};border-radius:0 4px 4px 0;margin-top:5px;font-size:0;line-height:0">&nbsp;</div>
  </td></tr>`).join('')

  const meal = s.mealShares?.[0]
  const mealBox = meal
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.surface2};border-radius:12px;margin:0 0 16px 0"><tr>
        <td valign="middle" style="padding:14px 0 14px 14px;font-size:28px;font-weight:700;color:${C.text};width:70px">${pct(meal.share)}</td>
        <td style="padding:14px;font-size:13.5px;color:${C.dim};line-height:1.45"><b style="color:${C.text}">Your ${escapeHtml(meal.name)} foods</b> made up ${pct(meal.share)} of everything you ate: ${fmt(meal.kcal)} kcal. You had all of them together on ${meal.fullDays} of ${s.daysLogged} logged days.</td>
      </tr></table>`
    : ''

  return card(`${h2('Where the calories came from')}${sub(`The ${s.topFoods.length} foods that added the most, out of ${fmt(s.kcal.total)} kcal across ${s.entryCount} entries and ${s.distinctFoods} different foods.`)}${mealBox}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`)
}

function dailyTable(s) {
  const th = (t, left) => `<th align="${left ? 'left' : 'right'}" style="font-size:11.5px;font-weight:600;color:${C.dim};padding:6px 4px;border-bottom:1px solid ${C.border}">${t}</th>`
  const td = (t, left, quiet) => `<td align="${left ? 'left' : 'right'}" style="font-size:12.5px;color:${quiet ? C.faint : C.text};padding:6px 4px;border-bottom:1px solid ${C.surface2};white-space:nowrap">${t}</td>`
  const day = (iso) => dateLabel(iso, { weekday: 'short', day: 'numeric' })
  const rows = s.days.map((d) => d.state === 'logged'
    ? `<tr>${td(day(d.date), true)}${td(fmt(d.kcal))}${td(d.est ? fmt(d.est) : '&mdash;')}${td(fmt(d.protein))}${td(fmt(d.carbs))}${td(fmt(d.fat))}${td(fmt(d.fiber))}</tr>`
    : `<tr>${td(day(d.date), true, true)}<td colspan="6" style="font-size:12.5px;color:${C.faint};padding:6px;border-bottom:1px solid ${C.surface2}">${d.state === 'before' ? 'before your first entry' : 'not logged'}</td></tr>`).join('')
  return card(`${h2('Daily numbers')}${sub(`${short(s.start)} to ${short(s.end)}. Grams for protein, carbs, fat and fiber.`)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${th('Day', true)}${th('kcal')}${th('Est.')}${th('Protein')}${th('Carbs')}${th('Fat')}${th('Fiber')}</tr>${rows}</table>`)
}

/** Shown in the inbox and atop the email, so the summary is easy to spot. */
export const EMOJI = '🥗'

export function subject(s) {
  return `${EMOJI} Food Log: ${short(s.start)} – ${short(s.end)} · median ${fmt(s.kcal.median)} kcal/day`
}

export function renderEmail(s) {
  const body = s.daysLogged === 0
    ? card(`${h2('Nothing logged')}${sub(`There are no entries between ${short(s.start)} and ${short(s.end)}.`)}`)
    : hero(s) + chartCard(s) + tiles(s) + foodsCard(s) + dailyTable(s)

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(subject(s))}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};color:${C.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:0 2px 16px 2px">
  <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.accent}">Food Log &middot; Weekly summary</div>
  <div style="font-size:32px;font-weight:700;color:${C.text};line-height:1.1;margin-top:6px"><span role="img" aria-label="salad">${EMOJI}</span> ${short(s.start)} – ${short(s.end)}</div>
  <div style="font-size:14px;color:${C.dim};line-height:1.45;margin-top:8px">Your weekly summary, read straight from your log.</div>
</td></tr>
${body}
<tr><td style="padding:4px 2px;font-size:12px;color:${C.faint}">Sent by the Food Log weekly summary job.</td></tr>
</table></td></tr></table></body></html>`
}

/** A plain-text alternative for clients that do not render HTML. */
export function renderText(s) {
  if (s.daysLogged === 0) return `Food Log ${short(s.start)} – ${short(s.end)}: nothing logged.`
  const lines = [
    `Food Log, ${short(s.start)} – ${short(s.end)}`,
    '',
    `Median ${fmt(s.kcal.median)} kcal/day, mean ${fmt(s.kcal.mean)}.`,
    `${s.daysLogged} of ${s.days.length} days logged.${s.missed.length ? ` Missed: ${s.missed.map(long).join(', ')}.` : ''}`,
    `Protein ${fmt(s.protein.mean)} g/day, fiber at least ${fmt(s.fiber.mean)} g/day.`,
    `${pct(s.estimated.share)} of calories were estimated.`,
    '',
    'Top foods by calories:',
    ...s.topFoods.map((f) => `  ${f.label}: ${fmt(f.kcal)} kcal (${f.times}x)${f.estimate ? ', estimate' : ''}`),
  ]
  return lines.join('\n')
}
