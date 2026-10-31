import { afterEach, describe, expect, it, vi } from 'vitest'
import { runExtraction } from './extract'
import { NVIDIA_TEXT_MODELS, NVIDIA_VISION_MODELS, WORKERS_AI_MODELS, extractionConfigured, modelChain } from './models'
import type { Env } from './shared'

/**
 * The model chain: one withdrawn model took photo logging down entirely, so
 * every request now falls through a list. These pin that each kind of
 * failure hands over to the next model, and that the last resort needs no
 * NVIDIA key at all.
 */

const ORIGINAL_FETCH = globalThis.fetch
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

const GOOD = JSON.stringify({
  name: 'Apple pie',
  serving_label: '1 slice',
  estimated: true,
  nutrition: { calories: 290, protein_g: 3, carbs_g: 40, fat_total_g: 13, fat_sat_g: 7, fat_trans_g: 0, fiber_g: 2 },
})

const PHOTO = [
  { type: 'text', text: 'read this' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
]

type Reply = number | 'hang' | 'garbage' | 'good'

/** Answers each NVIDIA model as told, recording which were asked, in order. */
function nvidia(replies: Record<string, Reply>) {
  const asked: string[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const model = JSON.parse(String(init.body)).model as string
    asked.push(model)
    const reply = replies[model] ?? 404
    if (reply === 'hang') {
      return new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
      )
    }
    if (typeof reply === 'number') return new Response('nope', { status: reply })
    const content = reply === 'good' ? GOOD : 'I cannot help with that.'
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }) as unknown as typeof fetch
  return asked
}

/** A Workers AI binding that answers as told. */
function workersAi(replies: Record<string, Reply>) {
  const asked: string[] = []
  const AI = {
    run: async (model: string) => {
      asked.push(model)
      const reply = replies[model] ?? 500
      if (reply === 'good') return { response: GOOD }
      if (reply === 'hang') return new Promise(() => {})
      throw new Error(`Workers AI ${reply}`)
    },
  } as unknown as Ai
  return { AI, asked }
}

const KEY = { NVIDIA_API_KEY: 'k' } as Env
const FAST = { perModelMs: 300, minAttemptMs: 50 }

describe('which models get tried', () => {
  it('tries the vision models for a photo, then Workers AI', () => {
    const { AI } = workersAi({})
    expect(modelChain({ ...KEY, AI } as Env, 'plate').map((p) => p.model)).toEqual([
      ...NVIDIA_VISION_MODELS,
      ...WORKERS_AI_MODELS,
    ])
  })

  it('tries text models, then vision models, then Workers AI for a description', () => {
    const { AI } = workersAi({})
    expect(modelChain({ ...KEY, AI } as Env, 'text').map((p) => p.model)).toEqual([
      ...NVIDIA_TEXT_MODELS,
      ...NVIDIA_VISION_MODELS,
      ...WORKERS_AI_MODELS,
    ])
  })

  it('no longer starts with the withdrawn 11B vision model', () => {
    expect(modelChain(KEY, 'plate')[0].model).not.toBe('meta/llama-3.2-11b-vision-instruct')
  })

  it('puts a still-configured old single model first rather than ignoring it', () => {
    const chain = modelChain({ ...KEY, NVIDIA_MODEL: 'some/pinned-model' } as Env, 'plate')
    expect(chain[0].model).toBe('some/pinned-model')
    expect(chain.filter((p) => p.model === 'some/pinned-model')).toHaveLength(1)
  })

  it('takes a comma-separated override from config', () => {
    const chain = modelChain({ ...KEY, NVIDIA_VISION_MODELS: ' a/one , b/two ' } as Env, 'plate')
    expect(chain.map((p) => p.model)).toEqual(['a/one', 'b/two'])
  })

  it('leaves out providers with no credential, and works with Workers AI alone', () => {
    const { AI } = workersAi({})
    expect(modelChain({ AI } as Env, 'plate').every((p) => p.via === 'workers-ai')).toBe(true)
    expect(modelChain(KEY, 'plate').every((p) => p.via === 'nvidia')).toBe(true)
    expect(extractionConfigured({ AI } as Env)).toBe(true)
    expect(extractionConfigured({} as Env)).toBe(false)
  })
})

describe('falling through the chain', () => {
  it('skips a withdrawn model and answers from the next', async () => {
    const asked = nvidia({ [NVIDIA_VISION_MODELS[0]]: 404, [NVIDIA_VISION_MODELS[1]]: 'good' })
    const out = await runExtraction(KEY, PHOTO, 'plate', 5_000, FAST)
    expect(out.ok).toBe(true)
    expect(asked).toEqual(NVIDIA_VISION_MODELS.slice(0, 2))
  })

  it('gives up on a stalled model after its slice, not the whole budget', async () => {
    nvidia({ [NVIDIA_VISION_MODELS[0]]: 'hang', [NVIDIA_VISION_MODELS[1]]: 'good' })
    const started = Date.now()
    const out = await runExtraction(KEY, PHOTO, 'plate', 5_000, FAST)
    expect(out.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('moves on from a server error', async () => {
    const asked = nvidia({ [NVIDIA_VISION_MODELS[0]]: 503, [NVIDIA_VISION_MODELS[1]]: 'good' })
    expect((await runExtraction(KEY, PHOTO, 'plate', 5_000, FAST)).ok).toBe(true)
    expect(asked).toHaveLength(2)
  })

  it('moves on from a reply it cannot read', async () => {
    const asked = nvidia({ [NVIDIA_VISION_MODELS[0]]: 'garbage', [NVIDIA_VISION_MODELS[1]]: 'good' })
    const out = await runExtraction(KEY, PHOTO, 'plate', 5_000, FAST)
    expect(out.ok).toBe(true)
    expect(asked).toHaveLength(2)
  })

  it('falls back to Workers AI when every NVIDIA model fails', async () => {
    nvidia({}) // all 404
    const { AI, asked } = workersAi({ [WORKERS_AI_MODELS[0]]: 'good' })
    const out = await runExtraction({ ...KEY, AI } as Env, PHOTO, 'plate', 5_000, FAST)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.name).toBe('Apple pie')
    expect(asked).toEqual([WORKERS_AI_MODELS[0]])
  })

  it('uses the second Workers AI model when the first fails', async () => {
    nvidia({})
    const { AI, asked } = workersAi({ [WORKERS_AI_MODELS[0]]: 500, [WORKERS_AI_MODELS[1]]: 'good' })
    expect((await runExtraction({ ...KEY, AI } as Env, PHOTO, 'plate', 5_000, FAST)).ok).toBe(true)
    expect(asked).toEqual(WORKERS_AI_MODELS)
  })

  it('skips the rest of NVIDIA once the key is rejected', async () => {
    // Every NVIDIA model would refuse the same key, so asking them all only
    // burns time before reaching the provider that does not need it.
    const asked = nvidia({ [NVIDIA_VISION_MODELS[0]]: 401 })
    const { AI } = workersAi({ [WORKERS_AI_MODELS[0]]: 'good' })
    expect((await runExtraction({ ...KEY, AI } as Env, PHOTO, 'plate', 5_000, FAST)).ok).toBe(true)
    expect(asked).toEqual([NVIDIA_VISION_MODELS[0]])
  })

  it('works with no NVIDIA key at all', async () => {
    const asked = nvidia({})
    const { AI } = workersAi({ [WORKERS_AI_MODELS[0]]: 'good' })
    expect((await runExtraction({ AI } as Env, PHOTO, 'plate', 5_000, FAST)).ok).toBe(true)
    expect(asked).toEqual([])
  })

  it('names every model tried, and why, when nothing works', async () => {
    nvidia({ [NVIDIA_VISION_MODELS[0]]: 'hang', [NVIDIA_VISION_MODELS[1]]: 503 })
    const { AI } = workersAi({})
    const out = await runExtraction({ ...KEY, AI } as Env, PHOTO, 'plate', 5_000, FAST)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toMatch(/No model could read that photo/)
    expect(out.error).toContain('llama-3.2-90b-vision-instruct (no answer in')
    expect(out.error).toContain('nemotron-3.5-super-vl-120b-a12b (HTTP 503)')
    expect(out.error).toContain('withdrawn, 404')
    expect(out.error).toContain('llama-4-scout-17b-16e-instruct (error)')
  })

  it('stops starting models once the budget is spent', async () => {
    nvidia(Object.fromEntries(NVIDIA_VISION_MODELS.map((m) => [m, 'hang'])))
    const started = Date.now()
    const out = await runExtraction(KEY, PHOTO, 'plate', 700, { perModelMs: 300, minAttemptMs: 200 })
    expect(out.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_500)
  })
})
