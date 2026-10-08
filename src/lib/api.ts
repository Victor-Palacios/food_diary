import { supabase } from './supabase'
import type { IsoDate } from './dates'
import { METRICS } from './types'
import type {
  DailyTotals,
  Food,
  FoodSource,
  FoodWithUsage,
  LogEntry,
  Meal,
  MealItem,
  NutritionInput,
  Snapshot,
  Target,
} from './types'

/**
 * Every read and write goes through here. Two invariants are enforced at this
 * layer rather than left to callers:
 *
 *  1. Numerics come back from PostgREST as strings (Postgres `numeric` has no
 *     lossless JSON form). They are coerced once, here, so no arithmetic
 *     anywhere else ever silently concatenates.
 *  2. Log entries are written from a SNAPSHOT, never from a food id alone.
 */

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? 'unknown error'}`)
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** null survives coercion: it means "not recorded", not zero. */
function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value)
}

function coerceFood<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>
  for (const metric of METRICS) {
    out[metric] = metric === 'fiber_g' ? numOrNull(row[metric]) : num(row[metric])
  }
  if (row.serving_grams != null) out.serving_grams = num(row.serving_grams)
  return out as T
}

function coerceEntry(row: Record<string, unknown>): LogEntry {
  const out = { ...row } as Record<string, unknown>
  for (const metric of METRICS) {
    const optional = metric === 'fiber_g'
    out[metric] = optional ? numOrNull(row[metric]) : num(row[metric])
    out[`s_${metric}`] = optional ? numOrNull(row[`s_${metric}`]) : num(row[`s_${metric}`])
  }
  out.multiplier = num(row.multiplier)
  return out as unknown as LogEntry
}

function coerceDaily(row: Record<string, unknown>): DailyTotals {
  const out = { ...row } as Record<string, unknown>
  for (const metric of METRICS) {
    // A day total's fiber sums what was recorded and counts the rest as
    // zero, so post-0003 it is always a number. NULL is preserved rather
    // than coerced because a pre-0003 view sends it for a partly-recorded
    // day, and reading that as 0 would assert a zero on a day with 21 g in
    // it. aggregate() tells those two cases apart.
    out[metric] = metric === 'fiber_g' ? numOrNull(row[metric]) : num(row[metric])
  }
  out.entry_count = num(row.entry_count)
  out.fiber_entry_count = num(row.fiber_entry_count)
  // Absent entirely from a pre-0004 view. Kept as null rather than read as 0,
  // which would report "none of this was estimated" when it simply is not known.
  out.estimated_calories = numOrNull(row.estimated_calories)
  out.has_estimate = row.has_estimate === true
  return out as unknown as DailyTotals
}

function coerceTarget(row: Record<string, unknown>): Target {
  return {
    ...row,
    calories_max: num(row.calories_max),
    protein_g: num(row.protein_g),
    carbs_g: num(row.carbs_g),
    fat_total_g: num(row.fat_total_g),
    fiber_g: num(row.fiber_g),
  } as Target
}

// ---------------------------------------------------------------------------
// Foods
// ---------------------------------------------------------------------------

export type FoodInput = NutritionInput & {
  name: string
  brand: string | null
  serving_label: string
  serving_grams: number | null
  source: FoodSource
  is_estimate: boolean
}

/**
 * The picker's list. Ordered by most-recently-eaten first, which is what makes
 * the repeat-food flow fast: the twenty foods of a typical week float to the
 * top on their own, with no favouriting UI to maintain.
 */
export async function listFoods(includeArchived = false): Promise<FoodWithUsage[]> {
  let query = supabase.from('foods').select('*')
  if (!includeArchived) query = query.eq('archived', false)

  const [foodsResult, usageResult] = await Promise.all([
    query.order('name'),
    supabase.from('food_usage').select('*'),
  ])

  if (foodsResult.error) fail('Could not load the food library', foodsResult.error)
  if (usageResult.error) fail('Could not load food usage', usageResult.error)

  const usage = new Map(
    (usageResult.data ?? []).map((u) => [
      u.food_id as string,
      { use_count: num(u.use_count), last_eaten_at: u.last_eaten_at as string | null },
    ]),
  )

  const foods: FoodWithUsage[] = (foodsResult.data ?? []).map((row) => {
    const stats = usage.get(row.id as string)
    return {
      ...coerceFood(row),
      use_count: stats?.use_count ?? 0,
      last_eaten_at: stats?.last_eaten_at ?? null,
    } as FoodWithUsage
  })

  return sortForPicker(foods)
}

/** Recently eaten first, then never-eaten foods alphabetically. */
export function sortForPicker(foods: FoodWithUsage[]): FoodWithUsage[] {
  return [...foods].sort((a, b) => {
    if (a.last_eaten_at && b.last_eaten_at) {
      return a.last_eaten_at < b.last_eaten_at ? 1 : a.last_eaten_at > b.last_eaten_at ? -1 : 0
    }
    if (a.last_eaten_at) return -1
    if (b.last_eaten_at) return 1
    return a.name.localeCompare(b.name)
  })
}

export async function createFood(input: FoodInput): Promise<Food> {
  const { data, error } = await supabase.from('foods').insert(input).select().single()
  if (error) fail('Could not save the food', error)
  return coerceFood(data) as Food
}

export async function updateFood(id: string, input: Partial<FoodInput>): Promise<Food> {
  const { data, error } = await supabase
    .from('foods')
    .update(input)
    .eq('id', id)
    .select()
    .single()
  if (error) fail('Could not update the food', error)
  return coerceFood(data) as Food
}

/**
 * Corrects whether a food's numbers are an estimate, and carries the
 * correction onto every entry already logged from it.
 *
 * Entries snapshot the flag when logged, so fixing only the food would leave
 * the mistake in exactly the place it matters: the dashboard's estimated
 * share is computed from entries. The macros in those snapshots stay
 * untouched -- this is a correction to where the numbers came from, not to
 * the numbers. Returns how many entries changed.
 */
export async function setFoodEstimate(foodId: string, isEstimate: boolean): Promise<number> {
  const { error } = await supabase.from('foods').update({ is_estimate: isEstimate }).eq('id', foodId)
  if (error) fail('Could not update the food', error)

  const { data, error: entriesError } = await supabase
    .from('log_entries')
    .update({ s_is_estimate: isEstimate })
    .eq('food_id', foodId)
    .neq('s_is_estimate', isEstimate)
    .select('id')
  if (entriesError) fail('Could not update the entries logged from that food', entriesError)
  return data?.length ?? 0
}

/**
 * Archive, never delete. Logged history keeps its own snapshot, but an
 * accidental delete would still lose the row a future entry could reuse.
 */
export async function setFoodArchived(id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.from('foods').update({ archived }).eq('id', id)
  if (error) fail('Could not archive the food', error)
}

// ---------------------------------------------------------------------------
// Log entries
// ---------------------------------------------------------------------------

export interface NewEntry {
  eaten_on: IsoDate
  food_id: string | null
  snapshot: Snapshot
  multiplier: number
  note: string | null
}

function entryRow(entry: NewEntry) {
  const { snapshot } = entry
  return {
    eaten_on: entry.eaten_on,
    food_id: entry.food_id,
    label: snapshot.label,
    multiplier: entry.multiplier,
    s_calories: snapshot.calories,
    s_protein_g: snapshot.protein_g,
    s_carbs_g: snapshot.carbs_g,
    s_fat_total_g: snapshot.fat_total_g,
    s_fat_sat_g: snapshot.fat_sat_g,
    s_fat_trans_g: snapshot.fat_trans_g,
    s_fiber_g: snapshot.fiber_g,
    s_source: snapshot.source,
    s_is_estimate: snapshot.is_estimate,
    note: entry.note,
  }
}

export async function createEntry(entry: NewEntry): Promise<LogEntry> {
  const { data, error } = await supabase
    .from('log_entries')
    .insert(entryRow(entry))
    .select()
    .single()

  if (error) fail('Could not save the entry', error)
  return coerceEntry(data)
}

/**
 * Several entries in one request, for logging a meal. One INSERT statement,
 * so it lands whole or not at all: a breakfast saved without its oats would
 * read 150 kcal short and look complete.
 */
export async function createEntries(entries: NewEntry[]): Promise<LogEntry[]> {
  if (entries.length === 0) return []
  // One statement means one now(), so every row would share a timestamp and
  // Today, which orders by it, would show the meal in an arbitrary order that
  // can change between loads. A millisecond apart keeps the meal's own order.
  const t0 = Date.now()
  const { data, error } = await supabase
    .from('log_entries')
    .insert(entries.map((entry, i) => ({ ...entryRow(entry), eaten_at: new Date(t0 + i).toISOString() })))
    .select()

  if (error) fail('Could not save the entries', error)
  return (data ?? []).map(coerceEntry)
}

/**
 * Only the fields that are genuinely mutable on a logged entry. The macro
 * snapshot is deliberately not among them -- changing the multiplier
 * recomputes this entry's totals and nothing else, and a correction to the
 * underlying food never reaches back into history.
 */
export interface EntryEdit {
  multiplier?: number
  eaten_on?: IsoDate
  note?: string | null
  /**
   * The one snapshot field that may change: whether the numbers were an
   * estimate is provenance, and a wrong flag skews the estimated share. The
   * numbers themselves stay as captured.
   */
  s_is_estimate?: boolean
}

export async function updateEntry(id: string, edit: EntryEdit): Promise<LogEntry> {
  const { data, error } = await supabase
    .from('log_entries')
    .update(edit)
    .eq('id', id)
    .select()
    .single()
  if (error) fail('Could not update the entry', error)
  return coerceEntry(data)
}

export async function deleteEntry(id: string): Promise<void> {
  const { error } = await supabase.from('log_entries').delete().eq('id', id)
  if (error) fail('Could not delete the entry', error)
}

/** Links a one-off entry to a food row created from it after the fact. */
export async function attachFoodToEntry(entryId: string, foodId: string): Promise<void> {
  const { error } = await supabase
    .from('log_entries')
    .update({ food_id: foodId })
    .eq('id', entryId)
  if (error) fail('Could not link the entry to the saved food', error)
}

export async function listEntries(from: IsoDate, to: IsoDate): Promise<LogEntry[]> {
  const { data, error } = await supabase
    .from('log_entries')
    .select('*')
    .gte('eaten_on', from)
    .lte('eaten_on', to)
    .order('eaten_at', { ascending: true })
  if (error) fail('Could not load entries', error)
  return (data ?? []).map(coerceEntry)
}

export async function listEntriesForDay(day: IsoDate): Promise<LogEntry[]> {
  return listEntries(day, day)
}

// ---------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------

/** What PostgREST says when a table is not there yet: migration 0005 is unrun. */
function isMissingTable(error: { code?: string; message: string }): boolean {
  return (
    error.code === 'PGRST205' ||
    error.code === '42P01' ||
    /could not find the table/i.test(error.message)
  )
}

/** Shown wherever a meal is written before the tables exist. */
export const MEALS_NEED_MIGRATION =
  'Saved meals need the database updated first. Run ' +
  'supabase/migrations/0005_meals.sql in the Supabase SQL editor.'

/**
 * Null, rather than an empty list, when the meals tables do not exist yet. The
 * picker must keep working before the migration is run, and it has to be able
 * to say why there are no meals rather than implying none were ever saved.
 */
export async function listMeals(): Promise<Meal[] | null> {
  const { data, error } = await supabase
    .from('meals')
    .select('id, owner_id, name, created_at, items:meal_items(id, meal_id, food_id, multiplier, position)')
    .order('name')

  if (error) {
    if (isMissingTable(error)) return null
    fail('Could not load meals', error)
  }

  return (data ?? []).map((row) => {
    const items = ((row.items ?? []) as Record<string, unknown>[])
      .map((item) => ({ ...item, multiplier: num(item.multiplier), position: num(item.position) }) as MealItem)
      .sort((a, b) => a.position - b.position)
    return { ...row, items } as Meal
  })
}

export interface NewMealItem {
  food_id: string
  multiplier: number
}

/**
 * Two requests, because PostgREST has no multi-table insert. If the items fail
 * the meal row is removed again, so a half-saved meal never appears in the
 * picker looking like a real one with nothing in it.
 */
export async function createMeal(name: string, items: NewMealItem[]): Promise<void> {
  const { data: meal, error } = await supabase
    .from('meals')
    .insert({ name: name.trim() })
    .select('id')
    .single()

  if (error) {
    if (isMissingTable(error)) throw new Error(MEALS_NEED_MIGRATION)
    if (error.code === '23505') {
      throw new Error(`There is already a meal called "${name.trim()}". Pick another name.`)
    }
    fail('Could not save the meal', error)
  }

  const { error: itemsError } = await supabase.from('meal_items').insert(
    items.map((item, i) => ({
      meal_id: meal.id,
      food_id: item.food_id,
      multiplier: item.multiplier,
      position: i + 1,
    })),
  )

  if (itemsError) {
    await supabase.from('meals').delete().eq('id', meal.id)
    fail('Could not save the meal', itemsError)
  }
}

/** Removes the shortcut only. Entries already logged from it are untouched. */
export async function deleteMeal(id: string): Promise<void> {
  const { error } = await supabase.from('meals').delete().eq('id', id)
  if (error) fail('Could not delete the meal', error)
}

// ---------------------------------------------------------------------------
// Daily totals
// ---------------------------------------------------------------------------

export async function listDailyTotals(from: IsoDate, to: IsoDate): Promise<DailyTotals[]> {
  const { data, error } = await supabase
    .from('daily_totals')
    .select('*')
    .gte('eaten_on', from)
    .lte('eaten_on', to)
    .order('eaten_on', { ascending: true })
  if (error) fail('Could not load daily totals', error)
  return (data ?? []).map(coerceDaily)
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type TargetInput = Omit<Target, 'id' | 'owner_id' | 'created_at'>

export async function listTargets(): Promise<Target[]> {
  const { data, error } = await supabase
    .from('targets')
    .select('*')
    .order('effective_from', { ascending: false })
  if (error) fail('Could not load targets', error)
  return (data ?? []).map(coerceTarget)
}

/**
 * Saving a target for a date that already has one replaces it, so correcting
 * a typo does not leave two rows fighting over the same day. `owner_id` is
 * sent explicitly because it is part of the conflict target.
 */
export async function upsertTarget(input: TargetInput): Promise<Target> {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) fail('Could not save the target', { message: 'not signed in' })

  const { data, error } = await supabase
    .from('targets')
    .upsert({ ...input, owner_id: auth.user.id }, { onConflict: 'owner_id,effective_from' })
    .select()
    .single()
  if (error) fail('Could not save the target', error)
  return coerceTarget(data)
}

export async function deleteTarget(id: string): Promise<void> {
  const { error } = await supabase.from('targets').delete().eq('id', id)
  if (error) fail('Could not delete the target', error)
}

/**
 * The active target for a date is the row with the greatest `effective_from`
 * on or before it. Targets are a handful of rows, so this is resolved in
 * memory from one fetch rather than a query per date.
 */
export function activeTarget(targets: Target[], date: IsoDate): Target | null {
  let best: Target | null = null
  for (const t of targets) {
    if (t.effective_from <= date && (!best || t.effective_from > best.effective_from)) {
      best = t
    }
  }
  return best
}
