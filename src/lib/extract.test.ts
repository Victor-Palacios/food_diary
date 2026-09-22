import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtractUnavailable, extractFromText } from './extract'

/**
 * The client half of extraction, which had no tests until two bugs had
 * already reached the user through it.
 *
 * Both were silent. An unreadable reply normalised into an all-zero form and
 * returned HTTP 200, so "it finished but nothing was populated" looked like a
 * model failure. And an absent fiber figure was coerced to 0, prefilling a
 * measurement nobody took on the one metric where absent and zero mean
 * different things.
 *
 * Neither would have been caught by testing the Worker alone: the Worker was
 * right in both cases. So the transport is exercised here for real -- actual
 * Response objects, actual streams -- rather than stubbing the module's own
 * internals and proving nothing.
 */

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

/** A streamed reply, the way the Worker actually sends one. */
function ndjson(lines: string[]): Response {
  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

/** Splits text so a line has to be reassembled from several reads. */
function everyNChars(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/**
 * Delivers the pieces as separate stream chunks. The first piece is followed
 * by a newline so it lands as its own line; the rest run together, which is
 * what makes the final line span reads.
 */
function chunked(pieces: string[], contentType: string): Response {
  const [first, ...rest] = pieces
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(first + '\n'))
      for (const piece of rest) controller.enqueue(encoder.encode(piece))
      controller.enqueue(encoder.encode('\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Sent {
  headers: Record<string, string>
}

/**
 * Answers each call with the next response, repeating the last one, and
 * records what was sent. An Error in the list is thrown, which is how a
 * transport failure arrives.
 */
function replyWith(...responses: Array<Response | Error>) {
  const queue = [...responses]
  const sent: Sent[] = []

  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    sent.push({ headers: (init.headers ?? {}) as Record<string, string> })
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if (next instanceof Error) throw next
    return next.clone()
  }) as unknown as typeof fetch

  return sent
}

const RESULT = {
  name: 'Mendocino Thai Mango Wrap',
  serving_label: '18.6 oz',
  estimated: false,
  nutrition: {
    calories: 1040,
    protein_g: 38,
    carbs_g: 112,
    fat_total_g: 50.5,
    fat_sat_g: 15,
    fat_trans_g: 0,
    fiber_g: 8,
  },
  notes: 'Read straight from your text.',
}

describe('reading a streamed reply', () => {
  it('ignores heartbeats and takes the final line', async () => {
    // The ':' lines are what stop Cloudflare's edge timing out at ~100s.
    replyWith(
      ndjson([':', ':', ':', JSON.stringify({ ok: true, result: RESULT })]),
    )
    const out = await extractFromText('anything')
    expect(out.name).toBe('Mendocino Thai Mango Wrap')
    expect(out.nutrition.calories).toBe(1040)
    expect(out.estimated).toBe(false)
  })

  it('reassembles a final line split across chunks', async () => {
    // A long result does not arrive in one piece, and a partial line must be
    // held rather than parsed and discarded.
    const payload = JSON.stringify({ ok: true, result: RESULT })
    replyWith(chunked([':', ...everyNChars(payload, 17)], 'application/x-ndjson'))

    const out = await extractFromText('anything')
    expect(out.name).toBe('Mendocino Thai Mango Wrap')
    expect(out.nutrition.calories).toBe(1040)
  })

  it('surfaces the error and what the model said', async () => {
    replyWith(
      ndjson([
        JSON.stringify({ ok: false, error: 'Could not read a result.', detail: 'I am unsure.' }),
      ]),
    )
    await expect(extractFromText('anything')).rejects.toThrow(/Could not read a result/)
    await expect(extractFromText('anything')).rejects.toThrow(/I am unsure/)
  })

  it('reports a stream that closed before any result', async () => {
    replyWith(ndjson([':', ':']))
    await expect(extractFromText('anything')).rejects.toThrow(/closed before a result/)
  })
})

describe('reading an immediate reply', () => {
  it('accepts plain JSON, which is what the local transcription path sends', async () => {
    // Text that states its own figures never reaches the model, so the
    // Worker answers at once with an ordinary JSON body even though the
    // client asked for a stream. That must not be mistaken for a failure.
    replyWith(json(RESULT))
    const out = await extractFromText('anything')
    expect(out.nutrition.calories).toBe(1040)
  })

  it('fails loudly on a body it cannot read, rather than returning an empty form', async () => {
    // This is the "it finished but nothing was populated" bug: a stale
    // client parsed newline-delimited output as JSON, got null, and
    // normalised that into an all-zero form with a 200 status.
    replyWith(
      new Response('{"ok":true,"result":{}}\n{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    )
    await expect(extractFromText('anything')).rejects.toThrow(/could not read/i)
  })

  it('reports extraction being unconfigured as its own kind of failure', async () => {
    replyWith(new Response('', { status: 501 }))
    await expect(extractFromText('anything')).rejects.toBeInstanceOf(ExtractUnavailable)
  })
})

describe('falling back when the connection drops', () => {
  it('retries without the stream after an iOS "Load failed"', async () => {
    // Safari reports a dropped long-lived connection as a bare TypeError,
    // and a streamed reply is exactly what it drops.
    const sent = replyWith(new TypeError('Load failed'), json(RESULT))
    const out = await extractFromText('anything')
    expect(out.nutrition.calories).toBe(1040)
    expect(sent).toHaveLength(2)
    // The first asks for a stream; the retry must not, or it would be
    // dropped the same way.
    expect(sent[0].headers.accept).toBe('application/x-ndjson')
    expect(sent[1].headers.accept).toBeUndefined()
  })

  it('does not retry when the server reported a real problem', async () => {
    const sent = replyWith(json({ error: 'That image is too large.' }, 413))
    await expect(extractFromText('anything')).rejects.toThrow(/too large/)
    expect(sent).toHaveLength(1)
  })
})

describe('normalising what comes back', () => {
  const withNutrition = (nutrition: Record<string, unknown>) =>
    ndjson([JSON.stringify({ ok: true, result: { name: 'Thing', nutrition } })])

  it('keeps an absent fiber figure unrecorded rather than zero', async () => {
    // Fiber is the one metric where absent and zero are different facts.
    // Coercing it prefilled a measurement nobody took, and the form gave no
    // reason to doubt it.
    replyWith(withNutrition({ calories: 300, fiber_g: null }))
    const out = await extractFromText('anything')
    expect(out.nutrition.fiber_g).toBeNull()
  })

  it('keeps a measured zero for fiber', async () => {
    replyWith(withNutrition({ calories: 300, fiber_g: 0 }))
    const out = await extractFromText('anything')
    expect(out.nutrition.fiber_g).toBe(0)
  })

  it('treats a missing fiber key the same as an explicit null', async () => {
    replyWith(withNutrition({ calories: 300 }))
    const out = await extractFromText('anything')
    expect(out.nutrition.fiber_g).toBeNull()
  })

  it('zeroes the metrics that are genuinely always measured', async () => {
    replyWith(withNutrition({ calories: 300, protein_g: 'n/a', carbs_g: undefined }))
    const out = await extractFromText('anything')
    expect(out.nutrition.protein_g).toBe(0)
    expect(out.nutrition.carbs_g).toBe(0)
  })

  it('reads a figure the model sent as a string with units', async () => {
    replyWith(withNutrition({ calories: '1,040 kcal', protein_g: '38 g' }))
    const out = await extractFromText('anything')
    expect(out.nutrition.calories).toBe(1040)
    expect(out.nutrition.protein_g).toBe(38)
  })

  it('refuses a reply that is nameless and all zeros', async () => {
    // Not a result, a misunderstanding dressed as one. Handing back a blank
    // form reads as "the model had no opinion", which is a different claim.
    replyWith(ndjson([JSON.stringify({ ok: true, result: { name: '', nutrition: {} } })]))
    await expect(extractFromText('anything')).rejects.toThrow(/nothing usable/)
  })

  it('assumes an estimate unless told otherwise', async () => {
    // Over-flagging is recoverable; under-flagging quietly files a guess as
    // measured data.
    replyWith(withNutrition({ calories: 300 }))
    expect((await extractFromText('x')).estimated).toBe(true)

    replyWith(ndjson([JSON.stringify({ ok: true, result: { ...RESULT, estimated: 'no' } })]))
    expect((await extractFromText('x')).estimated).toBe(true)
  })

  it('defaults a missing serving label rather than leaving it blank', async () => {
    replyWith(withNutrition({ calories: 300 }))
    expect((await extractFromText('x')).serving_label).toBe('1 serving')
  })
})
