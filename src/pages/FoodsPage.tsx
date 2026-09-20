import { useMemo, useState } from 'react'
import { FoodForm } from '../components/FoodForm'
import { IconPlus, IconSearch } from '../components/Icons'
import * as api from '../lib/api'
import { useAppData } from '../lib/AppData'
import { formatCalories } from '../lib/format'
import type { Food } from '../lib/types'

/**
 * The library. Create, edit, archive -- no delete, because a food row that
 * disappears can never be reused, and logged history is already independent
 * of it.
 */
export function FoodsPage() {
  const { foods, loading, error, refresh } = useAppData()
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<Food | null>(null)
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return foods
      .filter((f) => f.archived === showArchived)
      .filter(
        (f) =>
          !q ||
          f.name.toLowerCase().includes(q) ||
          (f.brand ? f.brand.toLowerCase().includes(q) : false),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [foods, search, showArchived])

  async function toggleArchive(food: Food) {
    setBusyId(food.id)
    try {
      await api.setFoodArchived(food.id, !food.archived)
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Food library</h1>
        <span className="sub">{foods.filter((f) => !f.archived).length} active</span>
      </div>

      <div style={{ position: 'relative', marginBottom: 12 }}>
        <IconSearch className="search-icon" />
        <input
          type="search"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search the library"
        />
      </div>

      <div className="seg">
        <button className={!showArchived ? 'on' : ''} onClick={() => setShowArchived(false)}>
          Active
        </button>
        <button className={showArchived ? 'on' : ''} onClick={() => setShowArchived(true)}>
          Archived
        </button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {loading ? (
        <div className="spinner" />
      ) : visible.length === 0 ? (
        <div className="card">
          <div className="empty">
            {showArchived
              ? 'Nothing archived.'
              : search.trim()
                ? `Nothing matches "${search.trim()}".`
                : 'No foods yet. Add the twenty you eat every week and the re-typing stops.'}
          </div>
        </div>
      ) : (
        <div className="card tight">
          {visible.map((food) => (
            <div className="row" key={food.id}>
              <button
                className="row-main"
                style={{ textAlign: 'left', minHeight: 40 }}
                onClick={() => setEditing(food)}
              >
                <div className="row-title">
                  {food.name}
                  {food.is_estimate ? <span className="pill estimate"> est</span> : null}
                </div>
                {/* Kept short enough not to truncate beside the button; the
                    full breakdown is one tap away in the editor. */}
                <div className="row-sub">
                  {food.brand ? `${food.brand} · ` : ''}
                  {food.serving_label} · {formatCalories(food.calories)} kcal
                </div>
              </button>
              <button
                className="btn sm"
                disabled={busyId === food.id}
                aria-label={`${food.archived ? 'Restore' : 'Archive'} ${food.name}`}
                onClick={() => void toggleArchive(food)}
              >
                {food.archived ? 'Restore' : 'Archive'}
              </button>
            </div>
          ))}
        </div>
      )}

      <button className="fab" onClick={() => setCreating(true)}>
        <IconPlus />
        Food
      </button>

      {creating ? (
        <FoodForm food={null} onClose={() => setCreating(false)} onSaved={refresh} />
      ) : null}

      {editing ? (
        <FoodForm food={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      ) : null}
    </>
  )
}
