import { useState } from 'react'
import { ExtractUnavailable, extractFromText, type ExtractResult } from '../lib/extract'
import { useExtractionAvailable } from '../lib/useExtraction'

interface Props {
  onResult: (result: ExtractResult) => void
}

const EXAMPLES = [
  'Chipotle chicken burrito bowl with rice, beans and guac',
  '2 scrambled eggs, 2 slices toast with butter, black coffee',
  'Large flat white and a blueberry muffin',
]

/**
 * Describe a meal in plain words and let the model do the arithmetic.
 *
 * This is the same estimate path as a plate photo -- same accuracy caveat,
 * same `is_estimate` flag -- but it needs no camera, which makes it the
 * practical option for restaurant food and for anything already eaten.
 *
 * It only ever prefills the form below it. The user reads every number and
 * presses save themselves; nothing reaches the log directly.
 */
export function TextEstimate({ onResult }: Props) {
  const available = useExtractionAvailable()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string | null>(null)

  if (!available) return null

  async function estimate() {
    const description = text.trim()
    if (!description) {
      setError('Type what you ate first.')
      return
    }

    setBusy(true)
    setError(null)
    setNotes(null)
    try {
      const result = await extractFromText(description)
      onResult(result)
      setNotes(result.notes?.trim() || null)
    } catch (e) {
      setError(
        e instanceof ExtractUnavailable
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="estimator">
      <div className="field-label">Describe what you ate</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={EXAMPLES[0]}
        rows={2}
        maxLength={600}
        // Enter submits; Shift+Enter makes a new line. One-handed on a phone,
        // reaching for a button after typing is the slowest part.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void estimate()
          }
        }}
      />

      <button
        type="button"
        className="btn primary block"
        style={{ marginTop: 8 }}
        disabled={busy || !text.trim()}
        onClick={() => void estimate()}
      >
        {busy ? 'Working it out…' : 'Estimate the macros'}
      </button>

      <div className="sub" style={{ marginTop: 8 }}>
        Fills in the fields below for you to check. Estimates run ±20–40%, so
        correct anything that looks wrong before saving.
      </div>

      {notes ? (
        <div className="notice info" style={{ marginTop: 8 }}>
          {notes}
        </div>
      ) : null}
      {error ? (
        <div className="notice error" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </div>
  )
}
