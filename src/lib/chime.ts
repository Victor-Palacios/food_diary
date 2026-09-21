/**
 * A short chime when an extraction finishes.
 *
 * Synthesised rather than shipped as an audio file: a two-note ping is a few
 * lines of Web Audio and costs nothing in the bundle or on the network, which
 * matters for something precached and used one-handed on a phone.
 *
 * Off is remembered per device. A sound you cannot silence is the kind of
 * thing you regret in a restaurant, which is exactly where this app is used.
 */

const STORAGE_KEY = 'foodlog.chime'

export function chimeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    // Private mode or blocked storage: default to on.
    return true
  }
}

export function setChimeEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // Not worth surfacing; the sound simply will not be remembered.
  }
}

type AudioContextCtor = typeof AudioContext

function audioContext(): AudioContext | null {
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  if (!Ctor) return null
  try {
    return new Ctor()
  } catch {
    return null
  }
}

/** One soft sine note with a quick fade, so nothing clicks. */
function note(
  ctx: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  peak: number,
): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.value = frequency

  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)

  osc.connect(gain).connect(ctx.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.02)
}

/**
 * `done` is a rising major third, which reads as finished and pleased.
 * `failed` is the same interval falling and quieter -- informative without
 * being a telling-off.
 */
export function playChime(kind: 'done' | 'failed' = 'done'): void {
  if (!chimeEnabled()) return

  const ctx = audioContext()
  if (!ctx) return

  const now = ctx.currentTime + 0.01
  if (kind === 'done') {
    note(ctx, 880, now, 0.12, 0.18) // A5
    note(ctx, 1108.73, now + 0.09, 0.22, 0.16) // C#6
  } else {
    note(ctx, 587.33, now, 0.12, 0.1) // D5
    note(ctx, 466.16, now + 0.1, 0.2, 0.09) // A#4
  }

  // Free the hardware once the tail has rung out.
  window.setTimeout(() => void ctx.close().catch(() => {}), 700)
}
