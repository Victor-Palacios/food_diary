import { METRICS, METRIC_LABELS, METRIC_UNITS, type Metric, type NutritionInput } from '../lib/types'

export type NutritionDraft = Record<Metric, string>

export const EMPTY_NUTRITION_DRAFT: NutritionDraft = {
  calories: '',
  protein_g: '',
  carbs_g: '',
  fat_total_g: '',
  fat_sat_g: '',
  fat_trans_g: '',
  fiber_g: '',
}

export function draftFromNutrition(source: NutritionInput): NutritionDraft {
  const draft = { ...EMPTY_NUTRITION_DRAFT }
  for (const metric of METRICS) {
    const value = source[metric]
    // Unrecorded fiber shows as an empty box, not a 0 the user has to notice
    // and delete.
    draft[metric] = value === null || value === undefined ? '' : String(value)
  }
  return draft
}

interface Props {
  value: NutritionDraft
  onChange: (next: NutritionDraft) => void
}

/**
 * The seven values, laid out in the order a nutrition label prints them so the
 * panel can be copied top to bottom without hunting. Blank means zero -- labels
 * routinely omit trans fat and fiber.
 */
export function NutritionFields({ value, onChange }: Props) {
  function set(metric: Metric, raw: string) {
    onChange({ ...value, [metric]: raw })
  }

  return (
    <>
      <div className="sub" style={{ marginBottom: 10 }}>
        Per one serving. Blank counts as zero, except fiber — leave that empty
        when it is not on the label and it stays out of the averages instead of
        counting as none.
      </div>
      <Field metric="calories" value={value} set={set} />
      <div className="grid-2">
        <Field metric="protein_g" value={value} set={set} />
        <Field metric="carbs_g" value={value} set={set} />
      </div>
      <div className="grid-3">
        <Field metric="fat_total_g" value={value} set={set} />
        <Field metric="fat_sat_g" value={value} set={set} />
        <Field metric="fat_trans_g" value={value} set={set} />
      </div>
      <Field metric="fiber_g" value={value} set={set} />
    </>
  )
}

function Field({
  metric,
  value,
  set,
}: {
  metric: Metric
  value: NutritionDraft
  set: (metric: Metric, raw: string) => void
}) {
  return (
    <label className="field">
      <span className="field-label">
        {METRIC_LABELS[metric]} ({METRIC_UNITS[metric]})
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value[metric]}
        placeholder="0"
        onChange={(e) => set(metric, e.target.value)}
      />
    </label>
  )
}
