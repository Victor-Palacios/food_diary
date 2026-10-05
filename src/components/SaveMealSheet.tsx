import { useState } from 'react'
import { Sheet } from './Sheet'
import * as api from '../lib/api'
import { formatMultiplier } from '../lib/format'
import { mealItemsFromEntries } from '../lib/meals'
import type { LogEntry } from '../lib/types'

interface Props {
  /** The entries picked on Today. One-offs are filtered out before this. */
  entries: LogEntry[]
  onClose: () => void
  onSaved: () => void
}

/** Names a meal made from entries already logged, at the servings actually eaten. */
export function SaveMealSheet({ entries, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const items = mealItemsFromEntries(entries)
  const labels = new Map(entries.map((e) => [e.food_id, e.label]))

  async function save() {
    if (!name.trim()) {
      setError('Give the meal a name so it can be found in the picker.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.createMeal(name, items)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Sheet
      title="Save as meal"
      onClose={onClose}
      footer={
        <button className="btn primary block" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : `Save ${items.length} foods as a meal`}
        </button>
      }
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Usual lunch"
          autoFocus
        />
      </label>

      <div className="card tight">
        {items.map((item) => (
          <div key={item.food_id} className="row">
            <div className="row-main">
              <div className="row-title">
                {item.multiplier !== 1 ? (
                  <span className="mult-tag">{formatMultiplier(item.multiplier)}</span>
                ) : null}
                {labels.get(item.food_id)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="sub" style={{ marginBottom: 12 }}>
        These are the usual servings. When you log the meal, any of them can be changed for
        that day only. The meal stores the foods, not their numbers, so a correction to a food
        in the library carries into the meal the next time you log it.
      </div>

      {error ? <div className="notice error">{error}</div> : null}
    </Sheet>
  )
}
