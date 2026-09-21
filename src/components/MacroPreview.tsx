import { formatCalories, formatGrams, NOT_RECORDED } from '../lib/format'
import type { NutritionInput } from '../lib/types'

interface Props {
  nutrition: NutritionInput
  /** Shows sat/trans fat too. Off in the entry sheet, on where detail matters. */
  detailed?: boolean
}

/**
 * The live readout. It updates as the multiplier changes, before anything is
 * saved -- the point is to see what 2x costs before committing to it.
 */
export function MacroPreview({ nutrition, detailed }: Props) {
  return (
    <div className="macros">
      <div className="macro hero">
        <div className="macro-v">{formatCalories(nutrition.calories)}</div>
        <div className="macro-k">calories</div>
      </div>
      <Cell label="protein" value={nutrition.protein_g} />
      <Cell label="carbs" value={nutrition.carbs_g} />
      <Cell label="fat" value={nutrition.fat_total_g} />
      <Cell label="fiber" value={nutrition.fiber_g} />
      {detailed ? (
        <>
          <Cell label="sat fat" value={nutrition.fat_sat_g} />
          <Cell label="trans fat" value={nutrition.fat_trans_g} />
        </>
      ) : null}
    </div>
  )
}

function Cell({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="macro">
      {/* A dash, not a zero: fiber is often simply not recorded. */}
      <div className="macro-v">{value === null ? NOT_RECORDED : formatGrams(value)}</div>
      <div className="macro-k">{label}</div>
    </div>
  )
}
