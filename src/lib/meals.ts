import { MULTIPLIER_MAX } from './config'
import type { IsoDate } from './dates'
import { scale, sumNutrition } from './stats'
import type { Food, Meal, Nutrition, Snapshot } from './types'
import type { NewEntry } from './api'

/**
 * Saved meals, as pure functions so the part that decides what gets written
 * can be tested without a database or a rendered sheet.
 *
 * The rule throughout: a meal is a shortcut for logging its foods one at a
 * time, and must produce exactly the entries that would have produced. Each
 * entry snapshots its food as it is now, keeps its own estimate flag and
 * fiber figure, and carries its own servings.
 */

/** What a food contributes to a log entry, the same whether picked alone or in a meal. */
export function snapshotFromFood(food: Food): Snapshot {
  return {
    label: food.brand ? `${food.name} (${food.brand})` : food.name,
    source: food.source,
    is_estimate: food.is_estimate,
    calories: food.calories,
    protein_g: food.protein_g,
    carbs_g: food.carbs_g,
    fat_total_g: food.fat_total_g,
    fat_sat_g: food.fat_sat_g,
    fat_trans_g: food.fat_trans_g,
    fiber_g: food.fiber_g,
  }
}

/** One row of the meal sheet: a food, today's servings, and whether it is being logged. */
export interface MealLine {
  itemId: string
  /** Undefined only if the food row is gone entirely. */
  food: Food | undefined
  /** False for an archived or missing food, which cannot be logged. */
  available: boolean
  multiplier: number
  included: boolean
}

/**
 * The sheet's starting state: every food ticked at its usual servings.
 *
 * `foods` must include archived ones. An archived food is kept as a visible,
 * unticked line rather than dropped, so a meal that has lost an ingredient
 * says so instead of quietly logging less than it used to.
 */
export function mealLines(meal: Meal, foods: Food[]): MealLine[] {
  const byId = new Map(foods.map((f) => [f.id, f]))
  return meal.items.map((item) => {
    const food = byId.get(item.food_id)
    const available = food !== undefined && !food.archived
    return {
      itemId: item.id,
      food,
      available,
      multiplier: item.multiplier,
      included: available,
    }
  })
}

function logged(lines: MealLine[]): Array<MealLine & { food: Food }> {
  return lines.filter(
    (l): l is MealLine & { food: Food } => l.included && l.available && l.food !== undefined,
  )
}

/** The entries to write: one per ticked, available food. */
export function entriesForMeal(lines: MealLine[], eatenOn: IsoDate): NewEntry[] {
  return logged(lines).map((line) => ({
    eaten_on: eatenOn,
    food_id: line.food.id,
    snapshot: snapshotFromFood(line.food),
    multiplier: line.multiplier,
    note: null,
  }))
}

/** What the ticked lines add up to, for the live preview and the picker row. */
export function mealTotal(lines: MealLine[]): Nutrition & { fiberEntryCount: number } {
  return sumNutrition(
    logged(lines).map((line) => scale(snapshotFromFood(line.food), line.multiplier)),
  )
}

/** How many entries the sheet will write. */
export function loggedCount(lines: MealLine[]): number {
  return logged(lines).length
}

/**
 * Turns entries already logged on Today into a meal's items -- the way a meal
 * is made, so its servings are what was actually eaten rather than retyped.
 *
 * Only entries from the library can go in: a one-off has no food row for the
 * meal to point at. The same food logged twice (fruit at breakfast and again
 * later, both selected) becomes one item with the servings added, since a
 * meal lists each food once.
 */
export function mealItemsFromEntries(
  entries: Array<{ food_id: string | null; multiplier: number }>,
): Array<{ food_id: string; multiplier: number }> {
  const merged = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.food_id) continue
    merged.set(entry.food_id, (merged.get(entry.food_id) ?? 0) + entry.multiplier)
  }
  return [...merged].map(([food_id, multiplier]) => ({
    food_id,
    multiplier: Math.min(MULTIPLIER_MAX, Math.round(multiplier * 100) / 100),
  }))
}

/**
 * The per-food servings stepper. Half a serving is the step because that is
 * how portions actually vary -- 3 or 4 servings of fruit, not 3.7 -- and it is
 * the smallest amount the stepper will go down to.
 *
 * A value off the half-step grid (a meal saved at 0.75x, say) steps to the
 * next grid point in the direction pressed, never past it.
 */
export const MEAL_STEP = 0.5

export function stepMultiplier(value: number, direction: 1 | -1): number {
  const units = value / MEAL_STEP
  const next =
    direction > 0
      ? (Math.floor(units + 1e-9) + 1) * MEAL_STEP
      : (Math.ceil(units - 1e-9) - 1) * MEAL_STEP
  return Math.min(MULTIPLIER_MAX, Math.max(MEAL_STEP, Math.round(next * 100) / 100))
}
