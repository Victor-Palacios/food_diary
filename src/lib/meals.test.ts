import { describe, expect, it } from 'vitest'
import {
  entriesForMeal,
  loggedCount,
  mealItemsFromEntries,
  mealLines,
  mealTotal,
  snapshotFromFood,
  stepMultiplier,
} from './meals'
import type { Food, Meal } from './types'

/**
 * A saved meal is a shortcut for logging its foods one at a time, so the test
 * that matters is that it writes exactly those entries -- each food's own
 * snapshot, servings, estimate flag and fiber -- and nothing a meal invented.
 *
 * The foods are the real usual breakfast, with the figures the library holds
 * for them.
 */

function food(id: string, name: string, calories: number, protein: number, fiber: number | null, extra: Partial<Food> = {}): Food {
  return {
    id,
    owner_id: 'o',
    name,
    brand: null,
    serving_label: '1 serving',
    serving_grams: null,
    calories,
    protein_g: protein,
    carbs_g: 0,
    fat_total_g: 0,
    fat_sat_g: 0,
    fat_trans_g: 0,
    fiber_g: fiber,
    source: 'label',
    is_estimate: false,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

const OATS = food('oats', 'steel cut oats', 150, 5, 4, { serving_label: '40 g' })
const FLAX = food('flax', 'ground flaxseed', 100, 4, 4, { serving_label: '17 g' })
const FRUIT = food('fruit', 'assorted fruit', 40, 0.5, 2, { serving_label: '70 g', source: 'manual' })
const PROTEIN = food('protein', 'protein powder', 120, 25, 0, { serving_label: '33 g' })
const FOODS = [OATS, FLAX, FRUIT, PROTEIN]

const BREAKFAST: Meal = {
  id: 'm',
  owner_id: 'o',
  name: 'Usual breakfast',
  created_at: '2026-10-05T00:00:00Z',
  // Deliberately out of order: position decides, not insertion order.
  items: [
    { id: 'i3', meal_id: 'm', food_id: 'fruit', multiplier: 4, position: 3 },
    { id: 'i1', meal_id: 'm', food_id: 'oats', multiplier: 1, position: 1 },
    { id: 'i2', meal_id: 'm', food_id: 'flax', multiplier: 1, position: 2 },
    { id: 'i4', meal_id: 'm', food_id: 'protein', multiplier: 1, position: 4 },
  ].sort((a, b) => a.position - b.position),
}

describe('the usual breakfast', () => {
  it('starts with every food ticked at its usual servings', () => {
    const lines = mealLines(BREAKFAST, FOODS)
    expect(lines.map((l) => [l.food?.name, l.multiplier, l.included])).toEqual([
      ['steel cut oats', 1, true],
      ['ground flaxseed', 1, true],
      ['assorted fruit', 4, true],
      ['protein powder', 1, true],
    ])
  })

  it('adds up to what four separate logs would have', () => {
    // 150 + 100 + 4 x 40 + 120
    const total = mealTotal(mealLines(BREAKFAST, FOODS))
    expect(total.calories).toBe(530)
    expect(total.protein_g).toBe(36)
    expect(total.fiber_g).toBe(16)
    expect(total.fiberEntryCount).toBe(4)
  })

  it('writes one entry per food, each with its own snapshot and servings', () => {
    const entries = entriesForMeal(mealLines(BREAKFAST, FOODS), '2026-10-05')
    expect(entries).toHaveLength(4)

    const fruit = entries.find((e) => e.food_id === 'fruit')!
    expect(fruit.multiplier).toBe(4)
    expect(fruit.eaten_on).toBe('2026-10-05')
    // The per-serving figures, not the scaled ones: the database multiplies.
    expect(fruit.snapshot.calories).toBe(40)
    expect(fruit.snapshot.label).toBe('assorted fruit')
    // Provenance is the food's own, not flattened across the meal.
    expect(fruit.snapshot.source).toBe('manual')
    expect(entries.find((e) => e.food_id === 'oats')!.snapshot.source).toBe('label')
  })

  it('leaves out a food unticked for today only', () => {
    const lines = mealLines(BREAKFAST, FOODS).map((l) =>
      l.food?.id === 'flax' ? { ...l, included: false } : l,
    )
    expect(loggedCount(lines)).toBe(3)
    expect(entriesForMeal(lines, '2026-10-05').map((e) => e.food_id)).toEqual(['oats', 'fruit', 'protein'])
    expect(mealTotal(lines).calories).toBe(430)
  })

  it('logs an adjusted serving without changing the saved meal', () => {
    const lines = mealLines(BREAKFAST, FOODS).map((l) =>
      l.food?.id === 'fruit' ? { ...l, multiplier: 3 } : l,
    )
    expect(entriesForMeal(lines, '2026-10-05').find((e) => e.food_id === 'fruit')!.multiplier).toBe(3)
    // The meal itself still says 4x for tomorrow.
    expect(BREAKFAST.items.find((i) => i.food_id === 'fruit')!.multiplier).toBe(4)
  })

  it('snapshots a food as it is now, so a correction reaches the next log', () => {
    // The meal stores foods, not numbers. Fixing the oats in the library is
    // picked up the next morning, and yesterday's entries keep their own.
    const corrected = { ...OATS, calories: 160 }
    const entries = entriesForMeal(mealLines(BREAKFAST, [corrected, FLAX, FRUIT, PROTEIN]), '2026-10-06')
    expect(entries.find((e) => e.food_id === 'oats')!.snapshot.calories).toBe(160)
  })
})

describe('a meal that has lost a food', () => {
  it('shows an archived food unticked instead of quietly logging less', () => {
    // Dropping it silently would log a breakfast 100 kcal short that looks
    // exactly like the complete one.
    const archived = { ...FLAX, archived: true }
    const lines = mealLines(BREAKFAST, [OATS, archived, FRUIT, PROTEIN])
    const flax = lines.find((l) => l.itemId === 'i2')!

    expect(lines).toHaveLength(4)
    expect(flax.available).toBe(false)
    expect(flax.included).toBe(false)
    expect(flax.food?.name).toBe('ground flaxseed')
    expect(loggedCount(lines)).toBe(3)
  })

  it('never writes an archived food even if it is ticked', () => {
    const archived = { ...FLAX, archived: true }
    const lines = mealLines(BREAKFAST, [OATS, archived, FRUIT, PROTEIN]).map((l) => ({ ...l, included: true }))
    expect(entriesForMeal(lines, '2026-10-05').map((e) => e.food_id)).not.toContain('flax')
  })

  it('handles a food row that is gone entirely', () => {
    const lines = mealLines(BREAKFAST, [OATS, FRUIT, PROTEIN])
    expect(lines.find((l) => l.itemId === 'i2')!.food).toBeUndefined()
    expect(entriesForMeal(lines, '2026-10-05')).toHaveLength(3)
  })
})

describe('what an entry inherits from its food', () => {
  it('carries the estimate flag, so the estimated share stays right', () => {
    const guessed = food('g', 'restaurant oatmeal', 300, 8, null, { is_estimate: true, source: 'photo' })
    const snap = snapshotFromFood(guessed)
    expect(snap.is_estimate).toBe(true)
    expect(snap.source).toBe('photo')
  })

  it('keeps unrecorded fiber unrecorded rather than zero', () => {
    expect(snapshotFromFood(food('x', 'x', 100, 1, null)).fiber_g).toBeNull()
  })

  it('names a branded food the way a single log does', () => {
    expect(snapshotFromFood(food('b', 'Pea Protein Milk', 140, 8, null, { brand: 'Ripple' })).label).toBe(
      'Pea Protein Milk (Ripple)',
    )
  })
})

describe('making a meal from entries already logged', () => {
  it('keeps the servings actually eaten, in the order picked', () => {
    expect(
      mealItemsFromEntries([
        { food_id: 'oats', multiplier: 1 },
        { food_id: 'fruit', multiplier: 4 },
      ]),
    ).toEqual([
      { food_id: 'oats', multiplier: 1 },
      { food_id: 'fruit', multiplier: 4 },
    ])
  })

  it('merges the same food logged twice, which a meal can only list once', () => {
    // The real log has fruit twice on one morning, both at 4x.
    expect(
      mealItemsFromEntries([
        { food_id: 'fruit', multiplier: 4 },
        { food_id: 'oats', multiplier: 1 },
        { food_id: 'fruit', multiplier: 4 },
      ]),
    ).toEqual([
      { food_id: 'fruit', multiplier: 8 },
      { food_id: 'oats', multiplier: 1 },
    ])
  })

  it('skips one-offs, which have no library food to point at', () => {
    expect(
      mealItemsFromEntries([
        { food_id: null, multiplier: 1 },
        { food_id: 'oats', multiplier: 1 },
      ]),
    ).toEqual([{ food_id: 'oats', multiplier: 1 }])
  })

  it('caps merged servings at what the database accepts', () => {
    expect(
      mealItemsFromEntries([
        { food_id: 'fruit', multiplier: 15 },
        { food_id: 'fruit', multiplier: 15 },
      ]),
    ).toEqual([{ food_id: 'fruit', multiplier: 20 }])
  })
})

describe('the servings stepper', () => {
  it('moves in half servings', () => {
    expect(stepMultiplier(4, 1)).toBe(4.5)
    expect(stepMultiplier(4, -1)).toBe(3.5)
  })

  it('never goes below half a serving', () => {
    expect(stepMultiplier(0.5, -1)).toBe(0.5)
  })

  it('snaps an off-grid value to the next step in the direction pressed', () => {
    expect(stepMultiplier(0.75, 1)).toBe(1)
    expect(stepMultiplier(0.75, -1)).toBe(0.5)
    expect(stepMultiplier(1.2, 1)).toBe(1.5)
    expect(stepMultiplier(1.2, -1)).toBe(1)
  })

  it('stops at the database ceiling', () => {
    expect(stepMultiplier(20, 1)).toBe(20)
    expect(stepMultiplier(19.75, 1)).toBe(20)
  })
})
