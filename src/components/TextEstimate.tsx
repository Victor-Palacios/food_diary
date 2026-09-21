import { useState } from 'react'
import { ExtractUnavailable, extractFromText, type ExtractResult } from '../lib/extract'
import { useElapsedSeconds, useExtractionAvailable } from '../lib/useExtraction'

interface Props {
  onResult: (result: ExtractResult) => void
}

const PLACEHOLDER =
  'Chicken bowl, 630 cal, 45g protein, 60g carbs, 22g fat\n— or just —\n2 eggs and toast with butter'

/**
 * Type a meal in plain words and let the model turn it into the seven fields.
 *
 * It handles two cases and tells them apart itself, so there is no mode to
 * choose:
 *
 *   - You already know the numbers (a label in your hand, published
 *     restaurant data). It transcribes them verbatim and the entry is NOT
 *     marked an estimate.
 *   - You only know the food. It estimates, and the entry IS marked an
 *     estimate, with the same accuracy caveat as a plate photo.
 *
 * Either way it only prefills the form below. The user reads every number and
 * presses save themselves; nothing reaches the log directly.
 */
export function TextEstimate({ onResult }: Props) {
  const available = useExtractionAvailable()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string | null>(null)
  const [wasEstimated, setWasEstimated] = useState<boolean | null>(null)
  const elapsed = useElapsedSeconds(busy)

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
    setWasEstimated(null)
    try {
      const result = await extractFromText(description)
      onResult(result)
      setNotes(result.notes?.trim() || null)
      setWasEstimated(result.estimated !== false)
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
        placeholder={PLACEHOLDER}
        rows={3}
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
        {busy ? `Working it out… ${elapsed}s` : 'Fill in the macros'}
      </button>

      {busy && elapsed > 20 ? (
        <div className="sub" style={{ marginTop: 6 }}>
          Still going — a cold model can take a while. It will wait up to five
          minutes before giving up.
        </div>
      ) : null}

      <div className="sub" style={{ marginTop: 8 }}>
        Include the numbers if you have them and they are copied across exactly.
        Give just the food and they are estimated instead.
      </div>

      {/* Say which of the two things actually happened, because it decides
          whether the entry is filed as an estimate. */}
      {wasEstimated === false ? (
        <div className="notice info" style={{ marginTop: 8 }}>
          <strong>Used your numbers as given.</strong> Not marked an estimate.
        </div>
      ) : wasEstimated === true ? (
        <div className="notice" style={{ marginTop: 8 }}>
          <strong>Estimated.</strong> These run ±20–40% — check them before
          saving. Marked as an estimate.
        </div>
      ) : null}

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
