import { useCallback, useEffect, useState } from 'react'
import { EntrySheet } from '../components/EntrySheet'
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
  }, [day, load])

  const totals = sumNutrition(entries)
  const target = api.activeTarget(targets, day)
  const isToday = day === today()

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

      <h2>
        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
      </h2>

      {loading ? (
        <div className="spinner" />
      ) : entries.length === 0 ? (
        <div className="card">
          <div className="empty">Nothing logged {isToday ? 'yet today' : 'for this day'}.</div>
        </div>
      ) : (
        <div className="card tight">
          {entries.map((entry) => (
            <button key={entry.id} className="row" onClick={() => setEditing(entry)}>
              <div className="row-main">
                <div className="row-title">
                  {entry.multiplier !== 1 ? (
                    <span className="mult-tag">{formatMultiplier(entry.multiplier)}</span>
                  ) : null}
                  {entry.label}
                </div>
                <div className="row-sub">
                  {formatTime(entry.eaten_at)}
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

      <button className="fab" onClick={() => setSheetOpen(true)}>
        <IconPlus />
        Log
      </button>

      {sheetOpen ? (
        <EntrySheet
          day={day}
          foods={foods}
          onClose={() => setSheetOpen(false)}
          onSaved={afterWrite}
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
