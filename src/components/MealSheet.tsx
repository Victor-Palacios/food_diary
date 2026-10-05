import { useMemo, useState } from 'react'
import { Sheet } from './Sheet'
import { MacroPreview } from './MacroPreview'
import { IconBack, IconTrash } from './Icons'
import * as api from '../lib/api'
import { useAppData } from '../lib/AppData'
import { formatCalories, formatMultiplier } from '../lib/format'
import type { IsoDate } from '../lib/dates'
import {
  MEAL_STEP,
  entriesForMeal,
  loggedCount,
  mealLines,
  mealTotal,
  stepMultiplier,
  type MealLine,
} from '../lib/meals'
import { MULTIPLIER_MAX } from '../lib/config'
import type { Meal } from '../lib/types'

interface Props {
  meal: Meal
  day: IsoDate
  onBack: () => void
  onClose: () => void
  onSaved: () => void
}

/**
 * Logging a saved meal: every food ticked at its usual servings, so the
 * common morning is one tap on the button. Anything different about today --
 * an extra serving of fruit, no flax -- is adjusted here, for today only.
 */
export function MealSheet({ meal, day, onBack, onClose, onSaved }: Props) {
  // All foods, archived included, so a meal that has lost one can say so.
  const { foods } = useAppData()
  const [lines, setLines] = useState<MealLine[]>(() => mealLines(meal, foods))
  const [eatenOn, setEatenOn] = useState<IsoDate>(day)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const total = useMemo(() => mealTotal(lines), [lines])
  const count = loggedCount(lines)

  function update(itemId: string, change: Partial<MealLine>) {
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, ...change } : l)))
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  function log() {
    void run(() => api.createEntries(entriesForMeal(lines, eatenOn)).then(() => undefined))
  }

  function remove() {
    if (!confirm(`Delete the "${meal.name}" meal? Entries already logged from it stay as they are.`)) return
    // onSaved refreshes the shared collections, which drops it from the picker.
    void run(() => api.deleteMeal(meal.id))
  }

  const unavailable = lines.filter((l) => !l.available).length

  return (
    <Sheet
      title={meal.name}
      onClose={onClose}
      lead={
        <button className="icon-btn" aria-label="Back to food list" onClick={onBack}>
          <IconBack />
        </button>
      }
      footer={
        <button className="btn primary block" onClick={log} disabled={busy || count === 0}>
          {busy
            ? 'Saving…'
            : count === 0
              ? 'Nothing ticked'
              : `Log ${count} ${count === 1 ? 'food' : 'foods'}`}
        </button>
      }
    >
      <div className="card tight meal-lines">
        {lines.map((line) => {
          const kcal = line.food ? line.food.calories * line.multiplier : 0
          const off = !line.included || !line.available
          return (
            <div key={line.itemId} className={off ? 'meal-line off' : 'meal-line'}>
              <label className="meal-line-main">
                <input
                  type="checkbox"
                  checked={line.included && line.available}
                  disabled={!line.available}
                  onChange={(e) => update(line.itemId, { included: e.target.checked })}
                  aria-label={`Log ${line.food?.name ?? 'this food'}`}
                />
                <span className="meal-line-text">
                  <span className="row-title">{line.food?.name ?? 'A deleted food'}</span>
                  <span className="row-sub">
                    {!line.available
                      ? 'No longer in the library — not logged'
                      : `${line.food!.serving_label} · ${formatCalories(kcal)} kcal`}
                  </span>
                </span>
              </label>
              {line.available ? (
                <div className="stepper" role="group" aria-label={`Servings of ${line.food!.name}`}>
                  <button
                    type="button"
                    aria-label="Fewer servings"
                    disabled={line.multiplier <= MEAL_STEP}
                    onClick={() => update(line.itemId, { multiplier: stepMultiplier(line.multiplier, -1) })}
                  >
                    −
                  </button>
                  <span className="stepper-v">{formatMultiplier(line.multiplier)}</span>
                  <button
                    type="button"
                    aria-label="More servings"
                    disabled={line.multiplier >= MULTIPLIER_MAX}
                    onClick={() => update(line.itemId, { multiplier: stepMultiplier(line.multiplier, 1) })}
                  >
                    +
                  </button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {unavailable > 0 ? (
        <div className="notice">
          {unavailable === 1 ? 'One food in this meal is' : `${unavailable} foods in this meal are`} archived,
          so {unavailable === 1 ? 'it is' : 'they are'} left out. Save the meal again from Today to replace{' '}
          {unavailable === 1 ? 'it' : 'them'}.
        </div>
      ) : null}

      <MacroPreview nutrition={total} />

      <label className="field" style={{ marginTop: 14 }}>
        <span className="field-label">Counts toward</span>
        <input type="date" value={eatenOn} onChange={(e) => e.target.value && setEatenOn(e.target.value)} />
      </label>

      <div className="sub" style={{ marginBottom: 12 }}>
        Changes here are for this time only. Each food is logged as its own entry, so any of
        them can be edited or deleted on Today afterwards.
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      <button className="btn ghost danger sm" onClick={remove} disabled={busy}>
        <IconTrash />
        Delete this meal
      </button>
    </Sheet>
  )
}
