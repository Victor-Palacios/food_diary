import { formatMetric, NOT_RECORDED, pluralize } from '../lib/format'
import {
  METRIC_LABELS,
  METRIC_UNITS,
  TARGETED_METRICS,
  isCeiling,
  targetFor,
  type NutritionInput,
  type Target,
} from '../lib/types'

interface Props {
  totals: NutritionInput
  target: Target | null
  /** Entries logged today, and how many of them recorded fiber. */
  entryCount?: number
  fiberEntryCount?: number
}

export function TargetProgress({ totals, target, entryCount, fiberEntryCount }: Props) {
  if (!target) {
    return (
      <div className="notice">
        No target is in effect for this date. Set one in Settings to see progress.
      </div>
    )
  }

  return (
    <div>
      {TARGETED_METRICS.map((metric) => {
        const goal = targetFor(target, metric)
        const raw = totals[metric]
        // An unrecorded metric has no progress to show. Drawing an empty bar
        // against the target would read as "none eaten", which is a
        // different and wrong claim.
        const unknown = raw === null || raw === undefined
        const value = unknown ? 0 : raw
        const pct = goal > 0 ? (value / goal) * 100 : 0
        const ceiling = isCeiling(metric)

        // Calories is a ceiling, so crossing it is a miss and 90% is a
        // warning. The rest are numbers to land near, shown neutrally.
        let tone = ''
        if (ceiling) {
          if (pct > 100) tone = 'over'
          else if (pct >= 90) tone = 'near'
        }

        const remaining = goal - value

        return (
          <div className="prog" key={metric}>
            <div className="prog-head">
              <span className="prog-name">
                {METRIC_LABELS[metric]}
                {ceiling ? ' (max)' : ''}
              </span>
              <span className="prog-val">
                <b>{unknown ? NOT_RECORDED : formatMetric(metric, value)}</b>
                <span className="muted">
                  {' / '}
                  {formatMetric(metric, goal)} {METRIC_UNITS[metric]}
                </span>
              </span>
            </div>
            <div className="prog-track">
              <div
                className={`prog-fill ${tone}`}
                style={{ width: unknown ? '0%' : `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
            {unknown ? (
              <div className="sub" style={{ marginTop: 4 }}>
                Not recorded for every entry today.
              </div>
            ) : null}
            {/* A fiber total covering some of the day is a floor, not a
                measurement. Showing it beats withholding it -- that is what
                hid 21 real grams behind a dash -- but it has to say so. */}
            {metric === 'fiber_g' &&
            !unknown &&
            entryCount !== undefined &&
            fiberEntryCount !== undefined &&
            fiberEntryCount < entryCount ? (
              <div className="sub" style={{ marginTop: 4 }}>
                At least this much: {fiberEntryCount} of {entryCount}{' '}
                {pluralize(entryCount, 'entry', 'entries')} recorded fiber.
              </div>
            ) : null}
            {ceiling ? (
              <div className="sub" style={{ marginTop: 4 }}>
                {remaining >= 0
                  ? `${formatMetric(metric, remaining)} left`
                  : `${formatMetric(metric, -remaining)} over`}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
