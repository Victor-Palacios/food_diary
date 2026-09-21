import type { Nutrition } from './types'

/**
 * Phase 2 client half. The API key lives server-side in the Worker -- this
 * module only ever talks to our own /api/extract, so the credential never
 * reaches the browser.
 *
 * Every path is review-before-save: the model prefills a form and the user
 * confirms. Nothing here writes to the log.
 */

export type ExtractKind = 'label' | 'plate' | 'text'

export interface ExtractResult {
  name: string
  serving_label: string
  nutrition: Nutrition
  /**
   * False only when the model transcribed figures the user supplied, rather
   * than inventing them. Drives `is_estimate`, so pasted restaurant data is
   * not filed as a guess. Absent means "assume estimate" -- over-flagging is
   * recoverable, under-flagging quietly corrupts the audit trail.
   */
  estimated?: boolean
  /** Model's own words about what it saw. Shown so the review is informed. */
  notes?: string
}

export class ExtractUnavailable extends Error {}

/**
 * Phone cameras produce 4-12 MB images. Downscaling before upload keeps the
 * request inside the model's payload limit and makes the round trip usable on
 * a phone connection; 1280px is still far more than enough to read a
 * nutrition panel.
 */
export async function compressImage(file: File, maxEdge = 1280): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not read the image on this device.')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  // Strips EXIF along the way, which is fine -- nothing downstream wants it.
  return canvas.toDataURL('image/jpeg', 0.85)
}

export async function extractFromPhoto(
  kind: 'label' | 'plate',
  file: File,
): Promise<ExtractResult> {
  const image = await compressImage(file)
  return post({ kind, image })
}

/**
 * Estimate from a written description -- "2 eggs, toast with butter, banana".
 * Same accuracy caveat as a plate photo, and the same estimate flag, but it
 * covers the restaurant case where there is nothing to photograph.
 */
export async function extractFromText(text: string): Promise<ExtractResult> {
  return post({ kind: 'text', text: text.trim() })
}

async function post(request: Record<string, unknown>): Promise<ExtractResult> {
  const response = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (response.status === 501) {
    throw new ExtractUnavailable(
      'AI extraction is not configured on this deployment.',
    )
  }

  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Extraction failed (${response.status}).`
    throw new Error(message)
  }

  return normalize(payload)
}

/**
 * The model is prompted for strict JSON, but a model is not a parser. Anything
 * missing or non-numeric becomes zero rather than NaN, so a partial read still
 * gives the user a form to correct instead of an error.
 */
function normalize(payload: unknown): ExtractResult {
  const obj = (payload ?? {}) as Record<string, unknown>
  const n = (obj.nutrition ?? {}) as Record<string, unknown>

  const num = (v: unknown): number => {
    const parsed = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.-]/g, ''))
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }

  const nutrition: Nutrition = {
    calories: num(n.calories),
    protein_g: num(n.protein_g),
    carbs_g: num(n.carbs_g),
    fat_total_g: num(n.fat_total_g),
    fat_sat_g: num(n.fat_sat_g),
    fat_trans_g: num(n.fat_trans_g),
    fiber_g: num(n.fiber_g),
  }

  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    serving_label:
      typeof obj.serving_label === 'string' && obj.serving_label.trim()
        ? obj.serving_label
        : '1 serving',
    // Only an explicit false counts as "the user gave me these numbers".
    estimated: obj.estimated === false ? false : true,
    nutrition,
    notes: typeof obj.notes === 'string' ? obj.notes : undefined,
  }
}
