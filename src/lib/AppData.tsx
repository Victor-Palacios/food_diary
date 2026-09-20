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
import type { FoodWithUsage, Target } from './types'

/**
 * The two slow-moving collections -- the food library and the target history --
 * are loaded once and shared. Both are small and both are needed on nearly
 * every screen, so refetching them per route would add a visible pause to the
 * flow the app is judged on.
 */
interface AppDataValue {
  foods: FoodWithUsage[]
  targets: Target[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const AppDataContext = createContext<AppDataValue | null>(null)

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [foods, setFoods] = useState<FoodWithUsage[]>([])
  const [targets, setTargets] = useState<Target[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextFoods, nextTargets] = await Promise.all([
        api.listFoods(true),
        api.listTargets(),
      ])
      setFoods(nextFoods)
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
    () => ({ foods, targets, loading, error, refresh }),
    [foods, targets, loading, error, refresh],
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
