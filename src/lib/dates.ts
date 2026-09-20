import { TIMEZONE } from './config'

/**
 * Dates in this app are calendar days in one fixed timezone, never instants.
 * `eaten_on` is assigned by local midnight in TIMEZONE, so every helper here
 * works on 'YYYY-MM-DD' strings and never on Date objects in the browser's
 * own zone -- a phone that travels must not reshuffle which day a meal
 * counted toward.
 */

export type IsoDate = string // 'YYYY-MM-DD'

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The current calendar day in the configured timezone. */
export function today(): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return dayFormatter.format(new Date())
}

/** The calendar day an instant falls on, in the configured timezone. */
export function dayOf(instant: string | Date): IsoDate {
  return dayFormatter.format(typeof instant === 'string' ? new Date(instant) : instant)
}

/** Parses 'YYYY-MM-DD' into its numeric parts. Throws on malformed input. */
function parts(date: IsoDate): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error(`Not an ISO date: ${date}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * Calendar arithmetic done in UTC so it is unaffected by DST. The result is a
 * calendar date, not an instant, so this is safe: adding one day to
 * '2025-03-09' gives '2025-03-10' whether or not the clocks moved.
 */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, mo, d] = parts(date)
  const t = Date.UTC(y, mo - 1, d) + days * 86_400_000
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const [ay, am, ad] = parts(a)
  const [by, bm, bd] = parts(b)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/** Every date from `start` to `end`, inclusive. */
export function dateRange(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  const n = daysBetween(start, end)
  for (let i = 0; i <= n; i++) out.push(addDays(start, i))
  return out
}

/** Monday-based week start, matching how a training week is usually read. */
export function startOfWeek(date: IsoDate): IsoDate {
  const [y, m, d] = parts(date)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  const backToMonday = (dow + 6) % 7
  return addDays(date, -backToMonday)
}

export function endOfWeek(date: IsoDate): IsoDate {
  return addDays(startOfWeek(date), 6)
}

export function startOfMonth(date: IsoDate): IsoDate {
  const [y, m] = parts(date)
  return `${y}-${pad(m)}-01`
}

export function endOfMonth(date: IsoDate): IsoDate {
  const [y, m] = parts(date)
  const dt = new Date(Date.UTC(y, m, 0)) // day 0 of next month = last of this
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

function weekdayOf(date: IsoDate): string {
  const [y, m, d] = parts(date)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

/** 'Mon 14 Apr' -- compact enough for a phone table row. */
export function formatShort(date: IsoDate): string {
  const [, m, d] = parts(date)
  return `${weekdayOf(date)} ${d} ${MONTHS[m - 1]}`
}

/** 'Monday, 14 April 2025' for headers. */
export function formatLong(date: IsoDate): string {
  const [y, m, d] = parts(date)
  const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const fullMonths = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  return `${full[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${d} ${fullMonths[m - 1]} ${y}`
}

/** 'Today' / 'Yesterday' / 'Mon 14 Apr'. */
export function formatRelative(date: IsoDate, now: IsoDate = today()): string {
  const diff = daysBetween(date, now)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff === -1) return 'Tomorrow'
  return formatShort(date)
}

/** 'Apr 2025'. */
export function formatMonth(date: IsoDate): string {
  const [y, m] = parts(date)
  return `${MONTHS[m - 1]} ${y}`
}

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** '14:32' in the configured timezone. */
export function formatTime(instant: string): string {
  return timeFormatter.format(new Date(instant))
}
