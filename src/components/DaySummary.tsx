import { formatCalories, formatGrams, pluralize } from '../lib/format'
import type { Nutrition, Target } from '../lib/types'

interface Props {
  totals: Nutrition
  target: Target | null
  /** Entries logged that day, and how many of them recorded fiber. */
  entryCount: number
  fiberEntryCount: number
}

const BARS = [
  { key: 'protein_g', label: 'Protein', goal: (t: Target) => t.protein_g },
  { key: 'carbs_g', label: 'Carbs', goal: (t: Target) => t.carbs_g },
  { key: 'fat_total_g', label: 'Fat', goal: (t: Target) => t.fat_total_g },
  { key: 'fiber_g', label: 'Fiber', goal: (t: Target) => t.fiber_g },
] as const

/**
 * The day at a glance: calories against the ceiling as a ring, the four
 * targeted macros as bars, and the two untargeted fats on one quiet line.
 *
 * Calories is the one ceiling, so only the ring changes color: amber from
 * 90%, red once over. The macro bars are numbers to land near and stay
 * neutral, the same rule as everywhere else in the app.
 */
export function DaySummary({ totals, target, entryCount, fiberEntryCount }: Props) {
  const ceiling = target?.calories_max ?? 0
  const pct = ceiling > 0 ? totals.calories / ceiling : 0
  const tone = pct > 1 ? 'over' : pct >= 0.9 ? 'near' : ''
  const left = ceiling - totals.calories

  return (
    <div className="card day">
      <div className="day-top">
        <div className="day-ring-wrap">
          <Ring fraction={pct} tone={tone} />
          <div className="day-ring-label">
            <div className="day-kcal">{formatCalories(totals.calories)}</div>
            <div className="day-kcal-k">{target ? `of ${formatCalories(ceiling)}` : 'kcal'}</div>
          </div>
        </div>
        <div className="day-left">
          {target ? (
            <>
              <div className={left < 0 ? 'day-left-v over' : 'day-left-v'}>
                {formatCalories(Math.abs(left))}
              </div>
              <div className="day-left-k">{left < 0 ? 'kcal over' : 'kcal left'}</div>
            </>
          ) : (
            <div className="day-left-k">No target set. Add one in Settings to see progress.</div>
          )}
        </div>
      </div>

      <div className="day-bars">
        {BARS.map((bar) => {
          const value = totals[bar.key]
          const goal = target ? bar.goal(target) : 0
          const width = goal > 0 ? Math.min(100, (value / goal) * 100) : 0
          return (
            <div className="day-bar" key={bar.key}>
              <div className="day-bar-k">{bar.label}</div>
              <div className="day-bar-v">
                <b>{formatGrams(value)}</b>
                <span className="muted">{goal > 0 ? ` / ${formatGrams(goal)} g` : ' g'}</span>
              </div>
              <div
                className="day-track"
                role="progressbar"
                aria-label={bar.label}
                aria-valuemin={0}
                aria-valuemax={goal || undefined}
                aria-valuenow={value}
              >
                <div className="day-fill" style={{ width: `${width}%` }} />
              </div>
              {/* A fiber total covering only some entries is a floor, and
                  has to say so next to the figure. */}
              {bar.key === 'fiber_g' && fiberEntryCount < entryCount ? (
                <div className="day-bar-note">
                  At least this much: {fiberEntryCount} of {entryCount}{' '}
                  {pluralize(entryCount, 'entry', 'entries')} recorded fiber
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="day-extra">
        Sat fat <b>{formatGrams(totals.fat_sat_g)} g</b>
        <span className="dot" aria-hidden="true">·</span>
        Trans fat <b>{formatGrams(totals.fat_trans_g)} g</b>
      </div>
    </div>
  )
}

/** A progress ring. Past 100% it stays full; the color and "over" say the rest. */
function Ring({ fraction, tone }: { fraction: number; tone: string }) {
  const r = 52
  const c = 2 * Math.PI * r
  const shown = Math.max(0, Math.min(1, fraction))
  return (
    <svg className="day-ring" viewBox="0 0 120 120" role="img" aria-label={`${Math.round(fraction * 100)}% of the calorie ceiling`}>
      <circle cx="60" cy="60" r={r} fill="none" className="day-ring-track" strokeWidth="10" />
      {shown > 0 ? (
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          className={`day-ring-fill ${tone}`}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${c * shown} ${c}`}
          transform="rotate(-90 60 60)"
        />
      ) : null}
    </svg>
  )
}
