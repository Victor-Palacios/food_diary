import { useMemo, useState } from 'react'
import { Sheet } from './Sheet'
import { MultiplierPicker } from './MultiplierPicker'
import { MacroPreview } from './MacroPreview'
import {
  EMPTY_NUTRITION_DRAFT,
  NutritionFields,
  draftFromNutrition,
  type NutritionDraft,
} from './NutritionFields'
import { PhotoButton } from './PhotoButton'
import { TextEstimate } from './TextEstimate'
import { IconBack, IconSearch, IconTrash } from './Icons'
import * as api from '../lib/api'
import { scale } from '../lib/stats'
import { formatMultiplier, parseNumber } from '../lib/format'
import { formatRelative, type IsoDate } from '../lib/dates'
import { METRICS } from '../lib/types'
import type { FoodSource, FoodWithUsage, LogEntry, Nutrition, Snapshot } from '../lib/types'

type Mode = 'pick' | 'quantity' | 'oneoff' | 'edit'

interface Props {
  day: IsoDate
  foods: FoodWithUsage[]
  /** When set the sheet opens straight into editing that entry. */
  editing?: LogEntry | null
  onClose: () => void
  onSaved: () => void
}

/**
 * The primary flow, and the one the acceptance criterion measures: open, pick
 * a repeat food, set a non-default multiplier, save. That path is four taps
 * with no typing, because the picker lists recently eaten foods first and the
 * multiplier presets are the first thing under the food's name.
 */
export function EntrySheet({ day, foods, editing, onClose, onSaved }: Props) {
  const [mode, setMode] = useState<Mode>(editing ? 'edit' : 'pick')
  const [selected, setSelected] = useState<FoodWithUsage | null>(null)
  const [multiplier, setMultiplier] = useState(editing ? editing.multiplier : 1)
  const [search, setSearch] = useState('')
  const [note, setNote] = useState(editing?.note ?? '')
  const [eatenOn, setEatenOn] = useState<IsoDate>(editing?.eaten_on ?? day)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // One-off draft.
  const [oneOffName, setOneOffName] = useState('')
  const [oneOffDraft, setOneOffDraft] = useState<NutritionDraft>(EMPTY_NUTRITION_DRAFT)
  const [oneOffServing, setOneOffServing] = useState('1 serving')
  const [alsoSave, setAlsoSave] = useState(false)
  const [oneOffEstimate, setOneOffEstimate] = useState(false)
  // Tracked separately from the estimate flag so provenance stays honest:
  // 'photo' only when a camera was actually involved.
  const [oneOffSource, setOneOffSource] = useState<FoodSource>('manual')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return foods
    return foods.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.brand ? f.brand.toLowerCase().includes(q) : false),
    )
  }, [foods, search])

  /** Per-serving values currently in play, whichever mode we are in. */
  const perServing: Nutrition = useMemo(() => {
    if (mode === 'edit' && editing) {
      return {
        calories: editing.s_calories,
        protein_g: editing.s_protein_g,
        carbs_g: editing.s_carbs_g,
        fat_total_g: editing.s_fat_total_g,
        fat_sat_g: editing.s_fat_sat_g,
        fat_trans_g: editing.s_fat_trans_g,
        fiber_g: editing.s_fiber_g,
      }
    }
    if (mode === 'quantity' && selected) {
      return {
        calories: selected.calories,
        protein_g: selected.protein_g,
        carbs_g: selected.carbs_g,
        fat_total_g: selected.fat_total_g,
        fat_sat_g: selected.fat_sat_g,
        fat_trans_g: selected.fat_trans_g,
        fiber_g: selected.fiber_g,
      }
    }
    const out = { ...EMPTY_NUTRITION_DRAFT } as unknown as Nutrition
    for (const metric of METRICS) out[metric] = parseNumber(oneOffDraft[metric]) ?? 0
    return out
  }, [mode, editing, selected, oneOffDraft])

  const preview = useMemo(() => scale(perServing, multiplier), [perServing, multiplier])

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

  function saveFromLibrary() {
    if (!selected) return
    const snapshot: Snapshot = {
      label: selected.brand ? `${selected.name} (${selected.brand})` : selected.name,
      source: selected.source,
      is_estimate: selected.is_estimate,
      ...perServing,
    }
    void run(() =>
      api
        .createEntry({
          eaten_on: eatenOn,
          food_id: selected.id,
          snapshot,
          multiplier,
          note: note.trim() || null,
        })
        .then(() => undefined),
    )
  }

  function saveOneOff() {
    const name = oneOffName.trim()
    if (!name) {
      setError('Give it a name so the log is readable later.')
      return
    }

    void run(async () => {
      let foodId: string | null = null

      if (alsoSave) {
        const food = await api.createFood({
          name,
          brand: null,
          serving_label: oneOffServing.trim() || '1 serving',
          serving_grams: null,
          source: oneOffSource,
          is_estimate: oneOffEstimate,
          ...perServing,
        })
        foodId = food.id
      }

      await api.createEntry({
        eaten_on: eatenOn,
        food_id: foodId,
        snapshot: {
          label: name,
          source: oneOffSource,
          is_estimate: oneOffEstimate,
          ...perServing,
        },
        multiplier,
        note: note.trim() || null,
      })
    })
  }

  function saveEdit() {
    if (!editing) return
    void run(() =>
      api
        .updateEntry(editing.id, {
          multiplier,
          eaten_on: eatenOn,
          note: note.trim() || null,
        })
        .then(() => undefined),
    )
  }

  function removeEntry() {
    if (!editing) return
    if (!confirm(`Delete "${editing.label}" from ${formatRelative(editing.eaten_on)}?`)) return
    void run(() => api.deleteEntry(editing.id))
  }

  /** "Save it afterward": promote a one-off entry into the library. */
  function promoteToLibrary() {
    if (!editing) return
    void run(async () => {
      const food = await api.createFood({
        name: editing.label,
        brand: null,
        serving_label: '1 serving',
        serving_grams: null,
        source: editing.s_source,
        is_estimate: editing.s_is_estimate,
        ...perServing,
      })
      await api.attachFoodToEntry(editing.id, food.id)
    })
  }

  // -------------------------------------------------------------------------
  // Picker
  // -------------------------------------------------------------------------

  if (mode === 'pick') {
    return (
      <Sheet
        title="Log food"
        onClose={onClose}
        flush
        footer={
          <button
            className="btn block"
            onClick={() => {
              setMode('oneoff')
              setMultiplier(1)
            }}
          >
            Describe something new
          </button>
        }
      >
        <div style={{ padding: '12px 14px 4px' }}>
          <div style={{ position: 'relative' }}>
            <IconSearch
              className="search-icon"
            />
            <input
              type="search"
              placeholder="Search foods"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search foods"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty">
            {foods.length === 0
              ? 'The library is empty. Add a food, or log a one-off below.'
              : `Nothing matches "${search.trim()}".`}
          </div>
        ) : (
          <div>
            {filtered.map((food) => (
              <button
                key={food.id}
                className="row"
                onClick={() => {
                  setSelected(food)
                  setMultiplier(1)
                  setMode('quantity')
                }}
              >
                <div className="row-main">
                  <div className="row-title">{food.name}</div>
                  <div className="row-sub">
                    {food.brand ? `${food.brand} · ` : ''}
                    {food.serving_label}
                    {food.is_estimate ? ' · estimate' : ''}
                  </div>
                </div>
                <div className="row-end">
                  <div className="row-kcal">{Math.round(food.calories)}</div>
                  <div className="row-sub">kcal</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Sheet>
    )
  }

  // -------------------------------------------------------------------------
  // Quantity (the hot path)
  // -------------------------------------------------------------------------

  if (mode === 'quantity' && selected) {
    return (
      <Sheet
        title={selected.name}
        onClose={onClose}
        lead={
          <button
            className="icon-btn"
            aria-label="Back to food list"
            onClick={() => setMode('pick')}
          >
            <IconBack />
          </button>
        }
        footer={
          <button className="btn primary block" onClick={saveFromLibrary} disabled={busy}>
            {busy ? 'Saving…' : `Save ${formatMultiplier(multiplier)}`}
          </button>
        }
      >
        <div className="sub" style={{ marginBottom: 12 }}>
          {selected.brand ? `${selected.brand} · ` : ''}
          {selected.serving_label}
        </div>

        <MultiplierPicker value={multiplier} onChange={setMultiplier} />

        <div style={{ height: 14 }} />
        <MacroPreview nutrition={preview} />

        <details style={{ marginTop: 14 }}>
          <summary className="sub" style={{ cursor: 'pointer', padding: '6px 0' }}>
            Date and note
          </summary>
          <div style={{ marginTop: 10 }}>
            <DateAndNote
              eatenOn={eatenOn}
              setEatenOn={setEatenOn}
              note={note}
              setNote={setNote}
            />
          </div>
        </details>

        {error ? <div className="notice error">{error}</div> : null}
      </Sheet>
    )
  }

  // -------------------------------------------------------------------------
  // One-off
  // -------------------------------------------------------------------------

  if (mode === 'oneoff') {
    return (
      <Sheet
        title="One-off entry"
        onClose={onClose}
        lead={
          editing ? undefined : (
            <button
              className="icon-btn"
              aria-label="Back to food list"
              onClick={() => setMode('pick')}
            >
              <IconBack />
            </button>
          )
        }
        footer={
          <button className="btn primary block" onClick={saveOneOff} disabled={busy}>
            {busy ? 'Saving…' : `Save ${formatMultiplier(multiplier)}`}
          </button>
        }
      >
        {/* Fastest path for unlabelled food: type it, let the model do the
            arithmetic, then correct whatever looks wrong. */}
        <TextEstimate
          onResult={(result) => {
            if (result.name) setOneOffName(result.name)
            setOneOffDraft(draftFromNutrition(result.nutrition))
            setOneOffServing(result.serving_label)
            // Numbers the user supplied are not an estimate. Flagging pasted
            // restaurant data as a guess would make it excludable from
            // analysis later, which is exactly backwards.
            setOneOffEstimate(result.estimated !== false)
            setOneOffSource(result.estimated === false ? 'restaurant' : 'manual')
          }}
        />

        <PhotoButton
          kind="plate"
          onResult={(result) => {
            setOneOffName(result.name)
            setOneOffDraft(draftFromNutrition(result.nutrition))
            setOneOffServing(result.serving_label)
            setOneOffEstimate(true)
            setOneOffSource('photo')
          }}
        />

        <label className="field">
          <span className="field-label">What was it?</span>
          <input
            type="text"
            value={oneOffName}
            onChange={(e) => setOneOffName(e.target.value)}
            placeholder="Chicken burrito, Casa Sanchez"
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field-label">Serving</span>
          <input
            type="text"
            value={oneOffServing}
            onChange={(e) => setOneOffServing(e.target.value)}
            placeholder="1 burrito"
          />
        </label>

        <NutritionFields value={oneOffDraft} onChange={setOneOffDraft} />

        <div className="field-label">Servings</div>
        <MultiplierPicker value={multiplier} onChange={setMultiplier} />
        <div style={{ height: 14 }} />
        <MacroPreview nutrition={preview} />

        <div style={{ height: 14 }} />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={oneOffEstimate}
            onChange={(e) => setOneOffEstimate(e.target.checked)}
          />
          This is an estimate
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={alsoSave}
            onChange={(e) => setAlsoSave(e.target.checked)}
          />
          Also save to the library
        </label>

        <DateAndNote
          eatenOn={eatenOn}
          setEatenOn={setEatenOn}
          note={note}
          setNote={setNote}
        />

        {error ? <div className="notice error">{error}</div> : null}
      </Sheet>
    )
  }

  // -------------------------------------------------------------------------
  // Edit an existing entry
  // -------------------------------------------------------------------------

  if (mode === 'edit' && editing) {
    return (
      <Sheet
        title={editing.label}
        onClose={onClose}
        footer={
          <div className="btn-row">
            <button className="btn danger" onClick={removeEntry} disabled={busy}>
              <IconTrash />
              Delete
            </button>
            <button className="btn primary" onClick={saveEdit} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="sub" style={{ marginBottom: 12 }}>
          Changing the servings recomputes this entry only. The saved macros are the
          ones captured when it was logged.
        </div>

        <MultiplierPicker value={multiplier} onChange={setMultiplier} />
        <div style={{ height: 14 }} />
        <MacroPreview nutrition={preview} detailed />

        <div style={{ height: 14 }} />
        <DateAndNote
          eatenOn={eatenOn}
          setEatenOn={setEatenOn}
          note={note}
          setNote={setNote}
        />

        {editing.food_id === null ? (
          <button className="btn block" onClick={promoteToLibrary} disabled={busy}>
            Save this to the library
          </button>
        ) : null}

        {error ? <div className="notice error">{error}</div> : null}
      </Sheet>
    )
  }

  return null
}

function DateAndNote({
  eatenOn,
  setEatenOn,
  note,
  setNote,
}: {
  eatenOn: IsoDate
  setEatenOn: (v: IsoDate) => void
  note: string
  setNote: (v: string) => void
}) {
  return (
    <>
      <label className="field">
        <span className="field-label">Counts toward</span>
        <input
          type="date"
          value={eatenOn}
          onChange={(e) => e.target.value && setEatenOn(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Note (optional)</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
    </>
  )
}
