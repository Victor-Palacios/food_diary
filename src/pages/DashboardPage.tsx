import { useCallback, useEffect, useMemo, useState } from 'react'
import { TargetProgress } from '../components/TargetProgress'
import { IconBack, IconForward } from '../components/Icons'
import * as api from '../lib/api'
import { useAppData } from '../lib/AppData'
import { aggregate, byDate, type Aggregate } from '../lib/stats'
import { formatCalories, formatOptional, pluralize } from '../lib/format'
import { BLOCK_DAYS } from '../lib/config'
import {
  addDays,
  dateRange,
  endOfMonth,
  endOfWeek,
  formatLong,
  formatMonth,
  formatShort,
  startOfMonth,
  startOfWeek,
  today,
  type IsoDate,
} from '../lib/dates'
import {
  METRICS,
  METRIC_LABELS,
  METRIC_SHORT,
  METRIC_UNITS,
  type DailyTotals,
  type Metric,
} from '../lib/types'

type Range = 'day' | 'week' | 'month' | 'block'

const RANGE_LABELS: Record<Range, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  block: '21 days',
}

export function DashboardPage() {
  const { targets } = useAppData()
  const [range, setRange] = useState<Range>('day')
  const [anchor, setAnchor] = useState<IsoDate>(today())
  const [days, setDays] = useState<DailyTotals[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const { start, end } = useMemo(() => bounds(range, anchor), [range, anchor])

  const load = useCallback(async (from: IsoDate, to: IsoDate) => {
    setLoading(true)
    try {
      setDays(await api.listDailyTotals(from, to))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(start, end)
  }, [start, end, load])

  const allDates = useMemo(() => dateRange(start, end), [start, end])
  const stats = useMemo(
    () => aggregate(days, start, end, allDates.length),
    [days, start, end, allDates.length],
  )

  function step(direction: number) {
    setAnchor(shift(range, anchor, direction))
  }

  /** Stepping forward past today has nothing to show. */
  const atPresent = bounds(range, anchor).end >= today()

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
      </div>

      <div className="seg">
        {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
          <button
            key={r}
            className={range === r ? 'on' : ''}
            onClick={() => {
              setRange(r)
              setAnchor(today())
            }}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>

      <div className="date-nav">
        <button className="icon-btn" aria-label="Previous" onClick={() => step(-1)}>
          <IconBack />
        </button>
        <div className="label">{rangeLabel(range, start, end)}</div>
        <button
          className="icon-btn"
          aria-label="Next"
          disabled={atPresent}
          style={{ opacity: atPresent ? 0.3 : 1 }}
          onClick={() => step(1)}
        >
          <IconForward />
        </button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {loading ? (
        <div className="spinner" />
      ) : (
        <>
          {range === 'day' ? (
            <DayView date={start} stats={stats} targets={targets} />
          ) : range === 'block' ? (
            <BlockView stats={stats} start={start} end={end} />
          ) : (
            <AverageView stats={stats} />
          )}

          {range !== 'day' ? (
            <DailyTable dates={allDates} days={days} />
          ) : null}
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Day
// ---------------------------------------------------------------------------

function DayView({
  date,
  stats,
  targets,
}: {
  date: IsoDate
  stats: Aggregate
  targets: ReturnType<typeof useAppData>['targets']
}) {
  const target = api.activeTarget(targets, date)

  if (stats.daysLogged === 0) {
    return (
      <>
        <div className="notice">Nothing logged on {formatLong(date)}.</div>
        <div className="card">
          <TargetProgress totals={stats.total} target={target} />
        </div>
      </>
    )
  }

  return (
    <>
      <div className="card">
        <MetricGrid nutrition={stats.total} caption="Total for the day" />
      </div>
      <div className="card">
        <TargetProgress totals={stats.total} target={target} />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Week / month -- daily averages, never sums
// ---------------------------------------------------------------------------

function AverageView({ stats }: { stats: Aggregate }) {
  return (
    <>
      <Coverage stats={stats} />
      {stats.daysLogged === 0 ? (
        <div className="card">
          <div className="empty">Nothing logged in this range.</div>
        </div>
      ) : (
        <div className="card">
          <MetricGrid
            nutrition={stats.mean}
            caption="Daily average across logged days"
          />
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// The 21-day block -- the output that feeds the DEXA comparison
// ---------------------------------------------------------------------------

function BlockView({
  stats,
  start,
  end,
}: {
  stats: Aggregate
  start: IsoDate
  end: IsoDate
}) {
  const complete = stats.daysLogged >= stats.daysInWindow
  const missing = stats.daysInWindow - stats.daysLogged

  return (
    <>
      <div className={complete ? 'coverage ok' : 'coverage short'}>
        <span>Days logged</span>
        <span className="coverage-n">
          {stats.daysLogged} / {stats.daysInWindow}
        </span>
      </div>

      {!complete ? (
        <div className="notice">
          <strong>
            {missing} {missing === 1 ? 'day is' : 'days are'} missing from this block.
          </strong>{' '}
          The figures below are the average of the {stats.daysLogged} logged{' '}
          {stats.daysLogged === 1 ? 'day' : 'days'} only — unlogged days are excluded,
          not counted as zero. Compare against a DEXA scan with that in mind.
        </div>
      ) : null}

      {stats.daysLogged === 0 ? (
        <div className="card">
          <div className="empty">
            Nothing logged between {formatShort(start)} and {formatShort(end)}.
          </div>
        </div>
      ) : (
        <>
          <div className="card block-hero">
            <div className="hero-pair">
              <div className="macro hero-stat" style={{ background: 'transparent', padding: 0 }}>
                <div className="macro-v">{formatCalories(stats.mean.calories)}</div>
                <div className="macro-k">mean kcal / day</div>
              </div>
              <div className="macro hero-stat" style={{ background: 'transparent', padding: 0 }}>
                <div className="macro-v">{formatCalories(stats.median.calories)}</div>
                <div className="macro-k">median kcal / day</div>
              </div>
            </div>
            <div className="sub">
              Averaged over {stats.daysLogged} logged{' '}
              {stats.daysLogged === 1 ? 'day' : 'days'} from {formatShort(start)} to{' '}
              {formatShort(end)}.
            </div>
          </div>

          <div className="card">
            <MetricGrid nutrition={stats.mean} caption="Mean per logged day" />
          </div>

          <div className="card">
            <h2>Mean vs median</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Mean</th>
                    <th>Median</th>
                  </tr>
                </thead>
                <tbody>
                  {METRICS.map((metric) => (
                    <tr key={metric}>
                      <td>
                        {METRIC_LABELS[metric]}
                        {/* Fiber counts an unrecorded entry as zero so the
                            figure is visible at all. Where that applies to
                            some of the block it is a floor, and the column
                            says which days it is fully based on. */}
                        {metric === 'fiber_g' && stats.fiberUnavailable ? (
                          <div className="sub">needs migration 0003</div>
                        ) : metric === 'fiber_g' &&
                          stats.fiberDaysKnown < stats.daysLogged ? (
                          <div className="sub">
                            at least — fully recorded on {stats.fiberDaysKnown} of{' '}
                            {stats.daysLogged} {pluralize(stats.daysLogged, 'day')}
                          </div>
                        ) : null}
                      </td>
                      <td>{formatOptional(metric, stats.mean[metric])}</td>
                      <td>{formatOptional(metric, stats.median[metric])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function Coverage({ stats }: { stats: Aggregate }) {
  const complete = stats.daysLogged >= stats.daysInWindow
  return (
    <div className={complete ? 'coverage ok' : 'coverage short'}>
      <span>Days logged</span>
      <span className="coverage-n">
        {stats.daysLogged} / {stats.daysInWindow}
      </span>
    </div>
  )
}

function MetricGrid({
  nutrition,
  caption,
}: {
  nutrition: Partial<Record<Metric, number | null>>
  caption: string
}) {
  return (
    <>
      <h2>{caption}</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            {METRICS.map((metric) => (
              <tr key={metric}>
                <td>{METRIC_LABELS[metric]}</td>
                <td>
                  {formatOptional(metric, nutrition[metric])}{' '}
                  <span className="muted">{METRIC_UNITS[metric]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/**
 * Every date in the window gets a row, logged or not. A missing day is shown
 * as a dash rather than skipped, so the gaps in a block are impossible to
 * overlook when reading the mean above it.
 */
function DailyTable({ dates, days }: { dates: IsoDate[]; days: DailyTotals[] }) {
  const index = useMemo(() => byDate(days), [days])

  return (
    <div className="card">
      <h2>Daily rows</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              {METRICS.map((metric) => (
                <th key={metric}>{METRIC_SHORT[metric]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dates.map((date) => {
              const row = index.get(date)
              return (
                <tr key={date} className={row ? undefined : 'unlogged'}>
                  <td>{formatShort(date)}</td>
                  {METRICS.map((metric) => (
                    <td key={metric} className={row ? undefined : 'unlogged'}>
                      {row ? formatOptional(metric, row[metric]) : '—'}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Range maths
// ---------------------------------------------------------------------------

function bounds(range: Range, anchor: IsoDate): { start: IsoDate; end: IsoDate } {
  switch (range) {
    case 'day':
      return { start: anchor, end: anchor }
    case 'week':
      return { start: startOfWeek(anchor), end: endOfWeek(anchor) }
    case 'month':
      return { start: startOfMonth(anchor), end: endOfMonth(anchor) }
    case 'block':
      // The block ends on the anchor, so the default view is the 21 days up to
      // and including today -- the window a scan is actually taken against.
      return { start: addDays(anchor, -(BLOCK_DAYS - 1)), end: anchor }
  }
}

function shift(range: Range, anchor: IsoDate, direction: number): IsoDate {
  switch (range) {
    case 'day':
      return addDays(anchor, direction)
    case 'week':
      return addDays(anchor, 7 * direction)
    case 'month': {
      const first = startOfMonth(anchor)
      return direction > 0 ? addDays(endOfMonth(first), 1) : startOfMonth(addDays(first, -1))
    }
    case 'block':
      return addDays(anchor, BLOCK_DAYS * direction)
  }
}

function rangeLabel(range: Range, start: IsoDate, end: IsoDate): string {
  switch (range) {
    case 'day':
      return formatLong(start)
    case 'week':
      return `${formatShort(start)} – ${formatShort(end)}`
    case 'month':
      return formatMonth(start)
    case 'block':
      return `${formatShort(start)} – ${formatShort(end)}`
  }
}
