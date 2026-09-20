import { useEffect, useState } from 'react'
import { MULTIPLIER_MAX, MULTIPLIER_MIN, MULTIPLIER_PRESETS } from '../lib/config'
import { formatMultiplier, parseMultiplier } from '../lib/format'

interface Props {
  value: number
  onChange: (value: number) => void
}

/**
 * Quick-tap presets cover almost every real serving; the free input handles
 * the rest. Default is 1x and pre-selected, so the common case costs zero
 * extra taps -- that is the whole reason this control exists.
 */
export function MultiplierPicker({ value, onChange }: Props) {
  const isPreset = MULTIPLIER_PRESETS.includes(value)
  const [free, setFree] = useState(isPreset ? '' : String(value))

  // Keep the free box in step when the value is changed from outside (e.g.
  // opening the sheet to edit an existing entry).
  useEffect(() => {
    if (MULTIPLIER_PRESETS.includes(value)) setFree('')
    else setFree(String(value))
  }, [value])

  function commitFree(raw: string) {
    setFree(raw)
    const parsed = parseMultiplier(raw)
    if (parsed === null) return
    const clamped = Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, parsed))
    // Two decimals is what the column stores.
    onChange(Math.round(clamped * 100) / 100)
  }

  return (
    <div className="mult">
      <div className="mult-presets" role="group" aria-label="Servings">
        {MULTIPLIER_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={preset === value ? 'mult-btn on' : 'mult-btn'}
            aria-pressed={preset === value}
            onClick={() => {
              setFree('')
              onChange(preset)
            }}
          >
            {formatMultiplier(preset)}
          </button>
        ))}
      </div>
      <input
        type="text"
        inputMode="decimal"
        className={!isPreset ? 'mult-free on' : 'mult-free'}
        placeholder="other"
        aria-label="Other serving multiplier"
        value={free}
        onChange={(e) => commitFree(e.target.value)}
        onBlur={() => {
          // A half-typed value should not leave the entry in a broken state.
          if (parseMultiplier(free) === null) setFree(isPreset ? '' : String(value))
        }}
      />
    </div>
  )
}
