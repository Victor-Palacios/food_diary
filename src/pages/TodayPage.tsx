import { useCallback, useEffect, useState } from 'react'
import { EntrySheet } from '../components/EntrySheet'
import { SaveMealSheet } from '../components/SaveMealSheet'
import { MacroPreview } from '../components/MacroPreview'
import { TargetProgress } from '../components/TargetProgress'
import { IconBack, IconForward, IconPlus } from '../components/Icons'
import * as api from '../lib/api'
import { useActiveFoods, useAppData } from '../lib/AppData'
import { sumNutrition } from '../lib/stats'
import { formatCalories, formatMultiplier } from '../lib/format'
import { addDays, formatRelative, formatTime, today, type IsoDate } from '../lib/dates'
import type { LogEntry } from '../lib/types'

/**
 * The home screen: what was eaten today, what it adds up to, and one button to
 * add more. The date can be stepped back for a late backfill, which keeps the
 * common case (today) free of any date picking at all.
 */
export function TodayPage() {
  const { targets, refresh: refreshShared } = useAppData()
  const foods = useActiveFoods()

  const [day, setDay] = useState<IsoDate>(today())
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<LogEntry | null>(null)
  // Picking entries to save as a meal. Ids, not entries, so a reload of the
  // day cannot leave a stale entry selected.
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [namingMeal, setNamingMeal] = useState(false)

  const load = useCallback(async (date: IsoDate) => {
    setLoading(true)
    try {
      setEntries(await api.listEntriesForDay(date))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(day)
    // A selection belongs to the day it was made on.
    setSelecting(false)
    setPicked(new Set())
  }, [day, load])

  const totals = sumNutrition(entries)
  const target = api.activeTarget(targets, day)
  const isToday = day === today()

  // Only library foods can go in a meal; a one-off has no food row to point at.
  const pickable = entries.filter((e) => e.food_id !== null)
  const pickedEntries = entries.filter((e) => picked.has(e.id))

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function stopSelecting() {
    setSelecting(false)
    setPicked(new Set())
  }

  function afterWrite() {
    void load(day)
    // The picker's ordering and the library both depend on what was just
    // logged, so the shared collections are refreshed too.
    void refreshShared()
  }

  return (
    <>
      <div className="date-nav">
        <button
          className="icon-btn"
          aria-label="Previous day"
          onClick={() => setDay(addDays(day, -1))}
        >
          <IconBack />
        </button>
        <div className="label">{formatRelative(day)}</div>
        <button
          className="icon-btn"
          aria-label="Next day"
          disabled={isToday}
          style={{ opacity: isToday ? 0.3 : 1 }}
          onClick={() => setDay(addDays(day, 1))}
        >
          <IconForward />
        </button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      <div className="card">
        <MacroPreview nutrition={totals} detailed />
      </div>

      <div className="card">
        <TargetProgress
          totals={totals}
          target={target}
          entryCount={entries.length}
          fiberEntryCount={totals.fiberEntryCount}
        />
      </div>

      <div className="list-head">
        <h2>
          {selecting
            ? `${picked.size} selected`
            : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
        </h2>
        {/* Making a meal from what was actually eaten is the only way to make
            one: the servings are then right without retyping anything. */}
        {!loading && !selecting && pickable.length >= 2 ? (
          <button className="btn ghost sm" onClick={() => setSelecting(true)}>
            Save as meal
          </button>
        ) : null}
      </div>

      {selecting ? (
        <div className="sub" style={{ marginBottom: 10 }}>
          Tick the foods that make up the meal, at the servings you had them.
        </div>
      ) : null}

      {loading ? (
        <div className="spinner" />
      ) : entries.length === 0 ? (
        <div className="card">
          <div className="empty">Nothing logged {isToday ? 'yet today' : 'for this day'}.</div>
        </div>
      ) : (
        <div className="card tight">
          {entries.map((entry) => (
            <button
              key={entry.id}
              className={selecting && entry.food_id === null ? 'row off' : 'row'}
              disabled={selecting && entry.food_id === null}
              aria-pressed={selecting ? picked.has(entry.id) : undefined}
              onClick={() => (selecting ? togglePick(entry.id) : setEditing(entry))}
            >
              {selecting ? (
                <input
                  type="checkbox"
                  className="row-check"
                  checked={picked.has(entry.id)}
                  disabled={entry.food_id === null}
                  readOnly
                  tabIndex={-1}
                  aria-hidden="true"
                />
              ) : null}
              <div className="row-main">
                <div className="row-title">
                  {entry.multiplier !== 1 ? (
                    <span className="mult-tag">{formatMultiplier(entry.multiplier)}</span>
                  ) : null}
                  {entry.label}
                </div>
                <div className="row-sub">
                  {selecting && entry.food_id === null
                    ? 'Not in the library, so it cannot go in a meal'
                    : formatTime(entry.eaten_at)}
                  {entry.s_is_estimate ? ' · estimate' : ''}
                  {entry.note ? ` · ${entry.note}` : ''}
                </div>
              </div>
              <div className="row-end">
                <div className="row-kcal">{formatCalories(entry.calories)}</div>
                <div className="row-sub">kcal</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* The bar is taller than the add button it replaces, and the page only
          reserves room for the button, so the last entry needs this to
          scroll clear of it. */}
      {selecting ? <div style={{ height: 32 }} aria-hidden="true" /> : null}

      {selecting ? (
        <div className="select-bar">
          <button className="btn" onClick={stopSelecting}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={pickedEntries.length < 2}
            onClick={() => setNamingMeal(true)}
          >
            {pickedEntries.length < 2 ? 'Pick at least 2' : `Save ${pickedEntries.length} as meal`}
          </button>
        </div>
      ) : (
        <button className="fab" onClick={() => setSheetOpen(true)}>
          <IconPlus />
          Log
        </button>
      )}

      {sheetOpen ? (
        <EntrySheet
          day={day}
          foods={foods}
          onClose={() => setSheetOpen(false)}
          onSaved={afterWrite}
        />
      ) : null}

      {namingMeal ? (
        <SaveMealSheet
          entries={pickedEntries}
          onClose={() => setNamingMeal(false)}
          onSaved={() => {
            stopSelecting()
            void refreshShared()
          }}
        />
      ) : null}

      {editing ? (
        <EntrySheet
          day={day}
          foods={foods}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={afterWrite}
        />
      ) : null}
    </>
  )
}
