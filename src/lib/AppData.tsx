import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import * as api from './api'
import type { FoodWithUsage, Meal, Target } from './types'

/**
 * The slow-moving collections -- the food library, saved meals and the target
 * history -- are loaded once and shared. All are small and needed on nearly
 * every screen, so refetching them per route would add a visible pause to the
 * flow the app is judged on.
 */
interface AppDataValue {
  foods: FoodWithUsage[]
  /** Null until migration 0005 creates the meals tables. */
  meals: Meal[] | null
  targets: Target[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const AppDataContext = createContext<AppDataValue | null>(null)

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [foods, setFoods] = useState<FoodWithUsage[]>([])
  const [meals, setMeals] = useState<Meal[] | null>([])
  const [targets, setTargets] = useState<Target[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextFoods, nextMeals, nextTargets] = await Promise.all([
        api.listFoods(true),
        api.listMeals(),
        api.listTargets(),
      ])
      setFoods(nextFoods)
      setMeals(nextMeals)
      setTargets(nextTargets)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(
    () => ({ foods, meals, targets, loading, error, refresh }),
    [foods, meals, targets, loading, error, refresh],
  )

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
}

export function useAppData(): AppDataValue {
  const value = useContext(AppDataContext)
  if (!value) throw new Error('useAppData must be used inside AppDataProvider')
  return value
}

/** The picker only ever offers foods that are still in use. */
export function useActiveFoods(): FoodWithUsage[] {
  const { foods } = useAppData()
  return useMemo(() => foods.filter((f) => !f.archived), [foods])
}
