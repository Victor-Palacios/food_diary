import { useState } from 'react'
import { Sheet } from '../components/Sheet'
import { IconPlus } from '../components/Icons'
import * as api from '../lib/api'
import { useAppData } from '../lib/AppData'
import { supabase } from '../lib/supabase'
import { chimeEnabled, playChime, setChimeEnabled } from '../lib/chime'
import { TIMEZONE } from '../lib/config'
import { formatCalories, formatGrams, parseNumber } from '../lib/format'
import { formatShort, today, type IsoDate } from '../lib/dates'
import type { Target } from '../lib/types'

/**
 * Targets move by 100 kcal every scan cycle. Each change is a new
 * effective-dated row rather than an edit in place, so a block logged in March
 * keeps being scored against March's target -- retroactively re-scoring old
 * blocks would corrupt the only comparison the app exists to support.
 */
export function SettingsPage() {
  const { targets, refresh } = useAppData()
  const [editing, setEditing] = useState<Target | null>(null)
  const [creating, setCreating] = useState(false)
  const [chime, setChime] = useState(chimeEnabled)

  const current = api.activeTarget(targets, today())

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <div className="card">
        <h2>Active target</h2>
        {current ? (
          <>
            <div className="flex-between" style={{ marginBottom: 6 }}>
              <span className="row-title">{formatCalories(current.calories_max)} kcal max</span>
              <span className="sub">since {formatShort(current.effective_from)}</span>
            </div>
            <div className="sub">
              {formatGrams(current.protein_g)} g protein · {formatGrams(current.carbs_g)} g
              carbs · {formatGrams(current.fat_total_g)} g fat ·{' '}
              {formatGrams(current.fiber_g)} g fiber
            </div>
          </>
        ) : (
          <div className="sub">
            No target set. Add one so the day view can show progress.
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Target history</h2>
          <button className="btn sm" onClick={() => setCreating(true)}>
            <IconPlus />
            New
          </button>
        </div>

        {targets.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <div style={{ margin: '0 -14px -14px' }}>
            {targets.map((target) => (
              <button key={target.id} className="row" onClick={() => setEditing(target)}>
                <div className="row-main">
                  <div className="row-title">
                    {formatCalories(target.calories_max)} kcal
                    {target.id === current?.id ? (
                      <span className="pill" style={{ marginLeft: 6 }}>
                        active
                      </span>
                    ) : null}
                  </div>
                  <div className="row-sub">
                    from {formatShort(target.effective_from)} · P{' '}
                    {formatGrams(target.protein_g)} · C {formatGrams(target.carbs_g)} · F{' '}
                    {formatGrams(target.fat_total_g)} · Fib {formatGrams(target.fiber_g)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Sound</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={chime}
            onChange={(e) => {
              setChime(e.target.checked)
              setChimeEnabled(e.target.checked)
              if (e.target.checked) playChime('done')
            }}
          />
          Chime when an estimate finishes
        </label>
        <div className="sub">
          A model call can take a minute, so this says when it is done without
          you watching the screen. Remembered on this device.
        </div>
      </div>

      <div className="card">
        <h2>About</h2>
        <div className="sub" style={{ lineHeight: 1.6 }}>
          Days are bounded by local midnight in <strong>{TIMEZONE}</strong>.
          <br />
          Entries keep a snapshot of a food's macros as they were when logged, so
          correcting a food later never rewrites past days.
        </div>
      </div>

      <button
        className="btn block"
        onClick={() => {
          void supabase.auth.signOut()
        }}
      >
        Sign out
      </button>

      {creating ? (
        <TargetForm
          target={null}
          previous={current}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      ) : null}

      {editing ? (
        <TargetForm
          target={editing}
          previous={null}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </>
  )
}

function TargetForm({
  target,
  previous,
  onClose,
  onSaved,
}: {
  target: Target | null
  /** Pre-fills a new target from the active one, minus the usual 100 kcal. */
  previous: Target | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [effectiveFrom, setEffectiveFrom] = useState<IsoDate>(
    target?.effective_from ?? today(),
  )
  const [calories, setCalories] = useState(
    String(target?.calories_max ?? (previous ? Math.max(0, previous.calories_max - 100) : 2300)),
  )
  const [protein, setProtein] = useState(String(target?.protein_g ?? previous?.protein_g ?? 140))
  const [carbs, setCarbs] = useState(String(target?.carbs_g ?? previous?.carbs_g ?? 300))
  const [fat, setFat] = useState(String(target?.fat_total_g ?? previous?.fat_total_g ?? 70))
  const [fiber, setFiber] = useState(String(target?.fiber_g ?? previous?.fiber_g ?? 15))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const values = {
      calories_max: parseNumber(calories),
      protein_g: parseNumber(protein),
      carbs_g: parseNumber(carbs),
      fat_total_g: parseNumber(fat),
      fiber_g: parseNumber(fiber),
    }

    if (Object.values(values).some((v) => v === null)) {
      setError('Every field must be a number.')
      return
    }
    if (!values.calories_max) {
      setError('A calorie ceiling is required.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      await api.upsertTarget({
        effective_from: effectiveFrom,
        calories_max: values.calories_max,
        protein_g: values.protein_g as number,
        carbs_g: values.carbs_g as number,
        fat_total_g: values.fat_total_g as number,
        fiber_g: values.fiber_g as number,
      })
      await onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function remove() {
    if (!target) return
    if (!confirm(`Delete the target effective ${formatShort(target.effective_from)}?`)) return
    setBusy(true)
    try {
      await api.deleteTarget(target.id)
      await onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={target ? 'Edit target' : 'New target'}
      onClose={onClose}
      footer={
        <div className="btn-row">
          {target ? (
            <button className="btn danger" onClick={() => void remove()} disabled={busy}>
              Delete
            </button>
          ) : null}
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save target'}
          </button>
        </div>
      }
    >
      <div className="sub" style={{ marginBottom: 12 }}>
        Applies from this date onward, until a later target supersedes it. Earlier days
        keep the target that was in effect when they were logged.
      </div>

      <label className="field">
        <span className="field-label">Effective from</span>
        <input
          type="date"
          value={effectiveFrom}
          onChange={(e) => e.target.value && setEffectiveFrom(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label">Calorie ceiling (kcal)</span>
        <input
          type="text"
          inputMode="decimal"
          value={calories}
          onChange={(e) => setCalories(e.target.value)}
        />
      </label>

      <div className="grid-2">
        <label className="field">
          <span className="field-label">Protein (g)</span>
          <input
            type="text"
            inputMode="decimal"
            value={protein}
            onChange={(e) => setProtein(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Carbs (g)</span>
          <input
            type="text"
            inputMode="decimal"
            value={carbs}
            onChange={(e) => setCarbs(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Fat (g)</span>
          <input
            type="text"
            inputMode="decimal"
            value={fat}
            onChange={(e) => setFat(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Fiber (g)</span>
          <input
            type="text"
            inputMode="decimal"
            value={fiber}
            onChange={(e) => setFiber(e.target.value)}
          />
        </label>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
    </Sheet>
  )
}
