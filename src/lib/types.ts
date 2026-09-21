export type FoodSource = 'label' | 'restaurant' | 'scale' | 'photo' | 'manual'

export const FOOD_SOURCES: FoodSource[] = [
  'label',
  'restaurant',
  'scale',
  'photo',
  'manual',
]

/** The seven tracked metrics, in the order they are shown everywhere. */
export const METRICS = [
  'calories',
  'protein_g',
  'carbs_g',
  'fat_total_g',
  'fat_sat_g',
  'fat_trans_g',
  'fiber_g',
] as const

export type Metric = (typeof METRICS)[number]

export const METRIC_LABELS: Record<Metric, string> = {
  calories: 'Calories',
  protein_g: 'Protein',
  carbs_g: 'Carbs',
  fat_total_g: 'Fat',
  fat_sat_g: 'Sat fat',
  fat_trans_g: 'Trans fat',
  fiber_g: 'Fiber',
}

export const METRIC_SHORT: Record<Metric, string> = {
  calories: 'kcal',
  protein_g: 'P',
  carbs_g: 'C',
  fat_total_g: 'F',
  fat_sat_g: 'Sat',
  fat_trans_g: 'Trans',
  fiber_g: 'Fib',
}

export const METRIC_UNITS: Record<Metric, string> = {
  calories: 'kcal',
  protein_g: 'g',
  carbs_g: 'g',
  fat_total_g: 'g',
  fat_sat_g: 'g',
  fat_trans_g: 'g',
  fiber_g: 'g',
}

/**
 * Metrics that may legitimately be unrecorded.
 *
 * Fiber is routinely absent from labels and restaurant data, so NULL means
 * "not recorded" and is deliberately distinct from a measured 0. Treating
 * the two alike would drag the fiber average down without ever saying why --
 * the same mistake as counting an unlogged day as a 0-calorie one.
 */
export type OptionalMetric = 'fiber_g'

/** Per-serving nutrition with everything known. Used for computed totals. */
export type Nutrition = Record<Metric, number>

/** Nutrition as entered or stored, where fiber may be unrecorded. */
export type NutritionInput = Omit<Nutrition, OptionalMetric> & {
  fiber_g: number | null
}

export const ZERO_NUTRITION: Nutrition = {
  calories: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_total_g: 0,
  fat_sat_g: 0,
  fat_trans_g: 0,
  fiber_g: 0,
}

export interface Food extends NutritionInput {
  id: string
  owner_id: string
  name: string
  brand: string | null
  serving_label: string
  serving_grams: number | null
  source: FoodSource
  is_estimate: boolean
  archived: boolean
  created_at: string
  updated_at: string
}

/** A food joined with how often it has been eaten, for picker ordering. */
export interface FoodWithUsage extends Food {
  use_count: number
  last_eaten_at: string | null
}

export interface LogEntry extends NutritionInput {
  id: string
  owner_id: string
  eaten_on: string
  eaten_at: string
  food_id: string | null
  label: string
  multiplier: number
  s_calories: number
  s_protein_g: number
  s_carbs_g: number
  s_fat_total_g: number
  s_fat_sat_g: number
  s_fat_trans_g: number
  s_fiber_g: number | null
  s_source: FoodSource
  s_is_estimate: boolean
  note: string | null
}

export interface DailyTotals extends NutritionInput {
  owner_id: string
  eaten_on: string
  entry_count: number
  /** How many of the day's entries recorded fiber. */
  fiber_entry_count: number
  has_estimate: boolean
}

export interface Target {
  id: string
  owner_id: string
  effective_from: string
  calories_max: number
  protein_g: number
  carbs_g: number
  fat_total_g: number
  fiber_g: number
  created_at: string
}

/** Target fields that map onto a metric. Sat and trans fat have no target. */
export type TargetedMetric = Exclude<Metric, 'fat_sat_g' | 'fat_trans_g'>

export const TARGETED_METRICS: TargetedMetric[] = [
  'calories',
  'protein_g',
  'carbs_g',
  'fat_total_g',
  'fiber_g',
]

/** Reads the target value that corresponds to a metric. */
export function targetFor(target: Target, metric: TargetedMetric): number {
  return metric === 'calories' ? target.calories_max : target[metric]
}

/**
 * Calories is the only metric the spec states a direction for: it is a
 * ceiling, and going over is a miss. The other four are numbers to land near,
 * so exceeding one is shown neutrally rather than as a failure -- the app
 * should not invent a judgement the owner never asked it to make.
 */
export function isCeiling(metric: TargetedMetric): boolean {
  return metric === 'calories'
}

/** The per-serving snapshot carried onto a new log entry. */
export interface Snapshot extends NutritionInput {
  label: string
  source: FoodSource
  is_estimate: boolean
}
