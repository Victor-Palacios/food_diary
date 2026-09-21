import { useRef, useState } from 'react'
import { IconCamera } from './Icons'
import {
  ExtractUnavailable,
  extractFromPhoto,
  type ExtractKind,
  type ExtractResult,
} from '../lib/extract'
import { useElapsedSeconds, useExtractionAvailable } from '../lib/useExtraction'
import { playChime } from '../lib/chime'

interface Props {
  kind: Extract<ExtractKind, 'label' | 'plate'>
  onResult: (result: ExtractResult) => void
}

/**
 * Phase 2 entry point. It only ever prefills the form it sits above -- the
 * user reviews every value and presses save themselves.
 *
 * When the deployment has no NVIDIA key the button is not rendered at all.
 * Phase 2 is explicitly optional, and an action that always fails is worse
 * than no action.
 */
export function PhotoButton({ kind, onResult }: Props) {
  const available = useExtractionAvailable()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string | null>(null)
  const elapsed = useElapsedSeconds(busy)

  if (!available) return null

  async function onFile(file: File) {
    setBusy(true)
    setError(null)
    setNotes(null)
    try {
      const result = await extractFromPhoto(kind, file)
      onResult(result)
      setNotes(result.notes?.trim() || null)
      playChime('done')
    } catch (e) {
      playChime('failed')
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
    <div className="photo">
      <button
        type="button"
        className="photo-btn"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <IconCamera />
        {busy
          ? `Reading the photo… ${elapsed}s`
          : kind === 'label'
            ? 'Scan a nutrition label'
            : 'Estimate from a photo'}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Reset so re-picking the same file fires change again.
          e.target.value = ''
          if (file) void onFile(file)
        }}
      />

      {kind === 'plate' ? (
        <div className="sub" style={{ marginTop: 6 }}>
          Estimates run ±20–40%. Check every value before saving.
        </div>
      ) : null}

      {notes ? <div className="notice info" style={{ marginTop: 8 }}>{notes}</div> : null}
      {error ? <div className="notice error" style={{ marginTop: 8 }}>{error}</div> : null}
    </div>
  )
}
