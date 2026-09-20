import { useState } from 'react'
import { Sheet } from './Sheet'
import { PhotoButton } from './PhotoButton'
import {
  EMPTY_NUTRITION_DRAFT,
  NutritionFields,
  draftFromNutrition,
  type NutritionDraft,
} from './NutritionFields'
import * as api from '../lib/api'
import { parseNumber } from '../lib/format'
import { FOOD_SOURCES, METRICS, type Food, type FoodSource, type Nutrition } from '../lib/types'

interface Props {
  /** Null creates a new food. */
  food: Food | null
  onClose: () => void
  onSaved: () => void
}

const SOURCE_LABELS: Record<FoodSource, string> = {
  label: 'Nutrition label',
  restaurant: 'Published restaurant data',
  scale: 'Weighed on a scale',
  photo: 'Photo estimate',
  manual: 'Entered by hand',
}

/**
 * Create or edit a library food. Values are per one serving, always -- the
 * multiplier lives on the log entry, so this form never asks "how much did you
 * eat". Two package sizes are two foods, deliberately: modelling package
 * variants is not worth the complexity at twenty foods a week.
 */
export function FoodForm({ food, onClose, onSaved }: Props) {
  const [name, setName] = useState(food?.name ?? '')
  const [brand, setBrand] = useState(food?.brand ?? '')
  const [servingLabel, setServingLabel] = useState(food?.serving_label ?? '')
  const [servingGrams, setServingGrams] = useState(
    food?.serving_grams != null ? String(food.serving_grams) : '',
  )
  const [source, setSource] = useState<FoodSource>(food?.source ?? 'label')
  const [isEstimate, setIsEstimate] = useState(food?.is_estimate ?? false)
  const [draft, setDraft] = useState<NutritionDraft>(
    food ? draftFromNutrition(food) : EMPTY_NUTRITION_DRAFT,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('A name is required.')
      return
    }
    if (!servingLabel.trim()) {
      setError('A serving label is required — it is what the picker shows.')
      return
    }

    const nutrition = {} as Nutrition
    for (const metric of METRICS) {
      const value = parseNumber(draft[metric])
      if (value === null) {
        setError(`"${draft[metric]}" is not a number.`)
        return
      }
      nutrition[metric] = value
    }

    const grams = servingGrams.trim() ? Number(servingGrams) : null
    if (grams !== null && (!Number.isFinite(grams) || grams <= 0)) {
      setError('Serving grams must be a positive number, or left blank.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const input: api.FoodInput = {
        name: trimmedName,
        brand: brand.trim() || null,
        serving_label: servingLabel.trim(),
        serving_grams: grams,
        source,
        is_estimate: isEstimate,
        ...nutrition,
      }
      if (food) await api.updateFood(food.id, input)
      else await api.createFood(input)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={food ? 'Edit food' : 'New food'}
      onClose={onClose}
      footer={
        <button className="btn primary block" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save food'}
        </button>
      }
    >
      {/* 7a: label OCR. Reading printed text, so this is the accurate half --
          it still only prefills, and the user confirms every value. */}
      <PhotoButton
        kind="label"
        onResult={(result) => {
          if (result.name) setName(result.name)
          setServingLabel(result.serving_label)
          setDraft(draftFromNutrition(result.nutrition))
          setSource('label')
        }}
      />

      <label className="field">
        <span className="field-label">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Optimum Nutrition Whey, Vanilla"
        />
      </label>

      <label className="field">
        <span className="field-label">Brand (optional)</span>
        <input type="text" value={brand} onChange={(e) => setBrand(e.target.value)} />
      </label>

      <label className="field">
        <span className="field-label">Serving label</span>
        <input
          type="text"
          value={servingLabel}
          onChange={(e) => setServingLabel(e.target.value)}
          placeholder="1 scoop (32 g)"
        />
      </label>

      <label className="field">
        <span className="field-label">Serving grams (optional)</span>
        <input
          type="text"
          inputMode="decimal"
          value={servingGrams}
          onChange={(e) => setServingGrams(e.target.value)}
          placeholder="32"
        />
      </label>

      <NutritionFields value={draft} onChange={setDraft} />

      <label className="field">
        <span className="field-label">Source</span>
        <select value={source} onChange={(e) => setSource(e.target.value as FoodSource)}>
          {FOOD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={isEstimate}
          onChange={(e) => setIsEstimate(e.target.checked)}
        />
        These numbers are an estimate
      </label>

      {error ? <div className="notice error">{error}</div> : null}
    </Sheet>
  )
}
