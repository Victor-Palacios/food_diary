import { describe, expect, it } from 'vitest'
import { isTranscription, parseJsonObject, readStatedValues } from './extract'

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

/**
 * Whether a description was transcribed or estimated decides `is_estimate`,
 * and a wrongly flagged entry is real data that looks like a guess. Models
 * were observed reporting an exact list of macros as an estimate, so the
 * judgement is made here from the user's own words instead.
 */
describe('reading figures the user stated', () => {
  it('reads a bulleted label list', () => {
    const stated = readStatedValues(`Here are the nutritional facts from the label:

* Protein: 47g
* Carbs: 68g
* Fat: 34g
* Fiber: 10g
* Calories: 766

This is for the Grass Fed Bison Meatloaf.`)

    expect(stated).toEqual({
      protein_g: 47,
      carbs_g: 68,
      fat_total_g: 34,
      fiber_g: 10,
      calories: 766,
    })
    expect(isTranscription(stated)).toBe(true)
  })

  it('reads the inline comma-separated form', () => {
    const stated = readStatedValues(
      'Chicken bowl, 630 cal, 45g protein, 60g carbs, 22g fat, 8g fiber',
    )
    expect(stated.calories).toBe(630)
    expect(stated.protein_g).toBe(45)
    expect(stated.carbs_g).toBe(60)
    expect(stated.fat_total_g).toBe(22)
    expect(stated.fiber_g).toBe(8)
    expect(isTranscription(stated)).toBe(true)
  })

  it('does not read saturated or trans fat as total fat', () => {
    const stated = readStatedValues(
      '500 calories, 20g protein, 40g carbs, 18g total fat, 6g saturated fat, 0g trans fat',
    )
    expect(stated.fat_total_g).toBe(18)
    expect(stated.fat_sat_g).toBe(6)
    expect(stated.fat_trans_g).toBe(0)
  })

  it('tolerates spelling, spacing and units', () => {
    const stated = readStatedValues('420 kcal / protein 28 g / carbohydrates: 44g / fat=14g / fibre 4g')
    expect(stated.calories).toBe(420)
    expect(stated.protein_g).toBe(28)
    expect(stated.carbs_g).toBe(44)
    expect(stated.fat_total_g).toBe(14)
    expect(stated.fiber_g).toBe(4)
  })

  it('finds nothing in a plain description', () => {
    const stated = readStatedValues('2 scrambled eggs, 2 slices toast with butter, black coffee')
    expect(stated.calories).toBeUndefined()
    expect(isTranscription(stated)).toBe(false)
  })

  it('does not mistake a quantity for a macro', () => {
    const stated = readStatedValues('200g grilled salmon and a cup of white rice')
    expect(stated.protein_g).toBeUndefined()
    expect(isTranscription(stated)).toBe(false)
  })

  it('needs all four core figures before calling it a transcription', () => {
    // Calories alone leaves the macros guessed, so it is still an estimate.
    expect(isTranscription(readStatedValues('Chipotle bowl, 800 cal'))).toBe(false)
    // Sat and trans fat are routinely absent from a label and must not
    // demote an otherwise exact entry.
    expect(
      isTranscription(readStatedValues('766 cal, 47g protein, 68g carbs, 34g fat')),
    ).toBe(true)
  })

  it('reads decimals', () => {
    const stated = readStatedValues('120 cal, 24g protein, 3g carbs, 1.5g fat')
    expect(stated.fat_total_g).toBe(1.5)
  })
})
