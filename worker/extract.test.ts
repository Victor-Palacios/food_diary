import { describe, expect, it } from 'vitest'
import { parseJsonObject } from './extract'

/**
 * A model is not a parser. These are the reply shapes that actually turn up:
 * fenced, prefaced with prose, narrated inside <think> tags, or simply cut
 * off when the token budget ran out.
 *
 * Every one of them used to produce "could not read a result from that
 * description" while the numbers sat in plain view, so each is pinned here.
 */

const GOOD = {
  name: 'Grass Fed Bison Meatloaf',
  serving_label: '1 meal',
  estimated: false,
  nutrition: {
    calories: 766,
    protein_g: 47,
    carbs_g: 68,
    fat_total_g: 34,
    fat_sat_g: 0,
    fat_trans_g: 0,
    fiber_g: 10,
  },
  notes: '',
}

const J = JSON.stringify(GOOD, null, 2)

function calories(text: string): unknown {
  const out = parseJsonObject(text)
  return (out?.nutrition as Record<string, unknown> | undefined)?.calories
}

describe('recovering JSON from a model reply', () => {
  it('reads a bare object', () => {
    expect(calories(J)).toBe(766)
  })

  it('reads a markdown fence', () => {
    expect(calories('```json\n' + J + '\n```')).toBe(766)
  })

  it('reads a fence wrapped in prose', () => {
    expect(calories('Sure! Here you go:\n\n```json\n' + J + '\n```\nHope that helps.')).toBe(766)
  })

  it('reads an object embedded in prose with no fence', () => {
    expect(calories('Here are the values: ' + J + ' Let me know.')).toBe(766)
  })

  it('ignores a closed <think> block', () => {
    expect(calories('<think>Exact numbers given, so transcribe.</think>\n' + J)).toBe(766)
  })

  it('is not fooled by braces inside the reasoning', () => {
    expect(calories('<think>maybe {"calories": 999}? no.</think>\n' + J)).toBe(766)
  })
})

describe('salvaging a truncated reply', () => {
  it('recovers an object cut off before the last key', () => {
    expect(calories(J.slice(0, J.indexOf('"notes"') - 4))).toBe(766)
  })

  it('recovers values already present when cut mid-nutrition', () => {
    const cut = '{"name":"x","estimated":false,"nutrition":{"calories":766,"protein_g":47,"carbs_g":'
    expect(calories(cut)).toBe(766)
  })

  it('recovers from an unterminated fence', () => {
    expect(calories('```json\n' + J.slice(0, -1))).toBe(766)
  })

  it('closes a string left open by truncation', () => {
    const out = parseJsonObject('{"name": "Bison Meat')
    expect(out).not.toBeNull()
    expect(out?.name).toBe('Bison Meat')
  })
})

describe('giving up cleanly', () => {
  it('returns null for prose with no object', () => {
    expect(parseJsonObject('I cannot determine the nutrition for that.')).toBeNull()
  })

  it('returns null for an empty reply', () => {
    expect(parseJsonObject('')).toBeNull()
  })

  it('returns null when reasoning never reached an answer', () => {
    expect(parseJsonObject('<think>still working through this')).toBeNull()
  })

  it('returns null for a bare array', () => {
    expect(parseJsonObject('[1, 2, 3]')).toBeNull()
  })
})
