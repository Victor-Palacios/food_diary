import { describe, expect, it } from 'vitest'
import {
  deriveName,
  deriveServing,
  isTranscription,
  parseJsonObject,
  parseLooseReply,
  readStatedValues,
  transcribeLocally,
} from './extract'

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

/**
 * Smaller vision models ignore the JSON instruction and answer in markdown.
 * Rejecting that told the user "could not read a result" while the numbers
 * sat in plain view in the very same reply, so it is parsed instead.
 *
 * The text below is what the 11B vision model actually returned in use.
 */
describe('reading a markdown reply', () => {
  const REAL = `**Nutrition Estimate for Organic Butter Bean Soup**
* **Name:** Organic Butter Bean Soup with Leeks, Organic Free-Range Chicken, and Smoked 5 Seed Crunch
* **Serving Label:** 1 plate as shown
* **Nutrition:**
  * Calories: 671
  * Protein: 51g
  * Carbs: 38g
  * Fat Total: 35g`

  it('recovers the values a real reply carried', () => {
    const out = parseLooseReply(REAL)
    expect(out).not.toBeNull()
    const n = out!.nutrition as Record<string, unknown>
    expect(n.calories).toBe(671)
    expect(n.protein_g).toBe(51)
    expect(n.carbs_g).toBe(38)
    expect(n.fat_total_g).toBe(35)
  })

  it('keeps the full dish name and serving', () => {
    const out = parseLooseReply(REAL)
    expect(out!.name).toBe(
      'Organic Butter Bean Soup with Leeks, Organic Free-Range Chicken, and Smoked 5 Seed Crunch',
    )
    expect(out!.serving_label).toBe('1 plate as shown')
  })

  it('leaves unstated fiber unrecorded rather than zero', () => {
    const n = parseLooseReply(REAL)!.nutrition as Record<string, unknown>
    expect(n.fiber_g).toBeNull()
    // Sat and trans fat genuinely default to 0; only fiber is optional.
    expect(n.fat_sat_g).toBe(0)
  })

  it('marks it an estimate, since the format was not followed either', () => {
    expect(parseLooseReply(REAL)!.estimated).toBe(true)
  })

  it('refuses a reply with no calorie figure', () => {
    expect(parseLooseReply('I could not identify the food in this photo.')).toBeNull()
  })

  it('reads a label written with words between it and the number', () => {
    const stated = readStatedValues('Calories (per serving): 671\nFat Total: 35g')
    expect(stated.calories).toBe(671)
    expect(stated.fat_total_g).toBe(35)
  })
})

/**
 * When the description already carries the figures, the model's answer is
 * thrown away -- applyStatedValues overwrites every value the user typed. The
 * two texts below are the ones the user actually sent; measured end to end,
 * the second took 50-80s on every attempt just to echo numbers back.
 *
 * So these are answered from the text alone. Both real inputs are pinned
 * here, because a wrong local answer is now a wrong answer with no model in
 * the loop to disagree with it.
 */
describe('answering from the text alone', () => {
  const BISON = `Here are the nutritional facts from the label:

* Protein: 47g
* Carbs: 68g
* Fat: 34g
* Fiber: 10g
* Calories: 766

This is for the Grass Fed Bison Meatloaf.`

  const SOUP = `Organic Butter Bean Soup with Leeks, Organic Free-Range Chicken, and Smoked 5 Seed Crunch
* **Serving Label:** 1 plate as shown
* **Nutrition:**
  * Calories: 671
  * Protein: 51g
  * Carbs: 38g
  * Fat Total: 35g
  * Fiber: 11g`

  it('transcribes the label list the user sent', () => {
    const out = transcribeLocally(BISON)
    expect(out?.ok).toBe(true)
    const result = (out as { ok: true; result: Record<string, unknown> }).result
    expect(result.nutrition).toEqual({
      calories: 766,
      protein_g: 47,
      carbs_g: 68,
      fat_total_g: 34,
      fat_sat_g: 0,
      fat_trans_g: 0,
      fiber_g: 10,
    })
    expect(result.estimated).toBe(false)
    expect(result.name).toBe('Grass Fed Bison Meatloaf')
  })

  it('transcribes the dish the model spent 50-80s echoing back', () => {
    const out = transcribeLocally(SOUP)
    expect(out?.ok).toBe(true)
    const result = (out as { ok: true; result: Record<string, unknown> }).result
    expect(result.nutrition).toEqual({
      calories: 671,
      protein_g: 51,
      carbs_g: 38,
      fat_total_g: 35,
      fat_sat_g: 0,
      fat_trans_g: 0,
      fiber_g: 11,
    })
    expect(result.estimated).toBe(false)
    expect(result.name).toBe(
      'Organic Butter Bean Soup with Leeks, Organic Free-Range Chicken, and Smoked 5 Seed Crunch',
    )
    expect(result.serving_label).toBe('1 plate as shown')
  })

  it('says which values it filled in rather than read', () => {
    const notes = String(
      (transcribeLocally(BISON) as { ok: true; result: Record<string, unknown> }).result.notes,
    )
    expect(notes).toMatch(/saturated fat/)
    expect(notes).toMatch(/trans fat/)
    // This line is read in the review sheet, so it names metrics the way a
    // person says them rather than the way the payload spells them.
    expect(notes).not.toMatch(/_g\b/)
    // Fiber was stated here, so it must not be listed as filled in.
    expect(notes).not.toMatch(/fiber/)
  })

  it('names one missing metric in the singular', () => {
    const notes = String(
      (
        transcribeLocally(
          'Chicken bowl, 630 cal, 45g protein, 60g carbs, 22g fat, 0g trans fat',
        ) as { ok: true; result: Record<string, unknown> }
      ).result.notes,
    )
    expect(notes).toMatch(/did not mention saturated fat, so that is recorded as 0/)
  })

  it('leaves unstated fiber unrecorded, not zero', () => {
    const out = transcribeLocally('766 cal, 47g protein, 68g carbs, 34g fat, bison meatloaf')
    const n = (out as { ok: true; result: Record<string, unknown> }).result
      .nutrition as Record<string, unknown>
    expect(n.fiber_g).toBeNull()
  })

  it('falls back to a default serving when none is given', () => {
    const out = transcribeLocally(BISON)
    expect((out as { ok: true; result: Record<string, unknown> }).result.serving_label).toBe(
      '1 serving',
    )
  })

  it('declines anything short of all four core figures, leaving it to the model', () => {
    expect(transcribeLocally('Chipotle chicken bowl, 800 cal')).toBeNull()
    expect(transcribeLocally('2 scrambled eggs, toast with butter, black coffee')).toBeNull()
    expect(transcribeLocally('766 cal, 47g protein, 68g carbs')).toBeNull()
  })
})

describe('naming a dish from the words around the figures', () => {
  it('drops the lead-in and keeps the dish', () => {
    expect(deriveName('Here are the facts: 500 cal, 20g protein, 40g carbs, 18g fat. Chicken Katsu Curry')).toBe(
      'Chicken Katsu Curry',
    )
  })

  it('keeps a name that shares its line with the figures', () => {
    expect(deriveName('Chicken bowl, 630 cal, 45g protein, 60g carbs, 22g fat')).toBe(
      'Chicken bowl',
    )
  })

  it('is not fooled by the section labels a model writes', () => {
    const name = deriveName(`* **Name:** Steak Frites
* **Serving Label:** 1 plate
* **Nutrition:**
  * Calories: 900`)
    // "Name:" is a label, not part of the dish.
    expect(name).toContain('Steak Frites')
    expect(name).not.toMatch(/Serving|Nutrition|Calories/)
  })

  it('returns empty rather than guessing when there is nothing but numbers', () => {
    expect(deriveName('766 cal, 47g protein, 68g carbs, 34g fat')).toBe('')
  })
})

describe('reading the serving the user stated', () => {
  it('reads it through markdown emphasis', () => {
    expect(deriveServing('* **Serving Label:** 1 plate as shown')).toBe('1 plate as shown')
  })

  it('reads a plain serving size', () => {
    expect(deriveServing('Serving size: 2 slices')).toBe('2 slices')
  })

  it('reports nothing when the text never says', () => {
    expect(deriveServing('Chicken bowl, 630 cal')).toBeUndefined()
  })
})

/**
 * A nutrition panel pasted as a markdown table.
 *
 * This is the text that produced the worst bug in the project: the parser
 * could not cross the comma in "1,040 kcal", matched the "040" and reported
 * 40 calories. applyStatedValues treats a stated figure as ground truth and
 * overwrites the model with it, so the meal would have been logged at 40 kcal
 * with nothing anywhere saying otherwise. It also found nothing else at all,
 * so the request went to the model and timed out -- which is how it surfaced.
 */
describe('reading a pasted nutrition table', () => {
  const WRAP = `Mendocino Thai Mango Wrap: |Nutrient         |Total     |
|-----------------|----------|
|Serving          |18.6 oz   |
|Calories         |1,040 kcal|
|Calories from Fat|460       |
|Total Fat        |50.5 g    |
|Saturated Fat    |15 g      |
|Trans Fat        |0 g       |
|Cholesterol      |60 mg     |
|Sodium           |2,150 mg  |
|Carbohydrates    |112 g     |
|Fiber            |8 g       |
|Total Sugar      |31 g      |
|Protein          |38 g      |`

  it('reads every figure out of the pipe columns', () => {
    expect(readStatedValues(WRAP)).toEqual({
      calories: 1040,
      protein_g: 38,
      carbs_g: 112,
      fat_total_g: 50.5,
      fat_sat_g: 15,
      fat_trans_g: 0,
      fiber_g: 8,
    })
  })

  it('does not read "Calories from Fat" as either calories or fat', () => {
    // 460 is on that row. Calories is 1,040 and total fat is 50.5; letting
    // the decoy win would corrupt whichever it reached first.
    const stated = readStatedValues(WRAP)
    expect(stated.calories).not.toBe(460)
    expect(stated.fat_total_g).not.toBe(460)
  })

  it('ignores the nutrients this app does not track', () => {
    // Cholesterol 60, sodium 2,150 and sugar 31 must not land anywhere.
    const values = Object.values(readStatedValues(WRAP))
    expect(values).not.toContain(60)
    expect(values).not.toContain(2150)
    expect(values).not.toContain(31)
  })

  it('answers it locally, so the model is never called', () => {
    const out = transcribeLocally(WRAP)
    expect(out?.ok).toBe(true)
    const result = (out as { ok: true; result: Record<string, unknown> }).result
    expect(result.estimated).toBe(false)
    expect(result.name).toBe('Mendocino Thai Mango Wrap')
    expect(result.serving_label).toBe('18.6 oz')
    expect((result.nutrition as Record<string, unknown>).calories).toBe(1040)
  })
})

describe('figures written with thousands separators', () => {
  it('reads 1,040 as 1040 rather than 40', () => {
    expect(readStatedValues('1,040 kcal').calories).toBe(1040)
    expect(readStatedValues('Calories: 1,040').calories).toBe(1040)
    expect(readStatedValues('Calories | 1,040').calories).toBe(1040)
  })

  it('reads a figure in the millions', () => {
    expect(readStatedValues('Calories: 1,234,567').calories).toBe(1234567)
  })

  it('keeps a comma between two figures as a separator', () => {
    // The grouped form needs exactly three digits after the comma, so this
    // is still two numbers rather than one.
    const stated = readStatedValues('630 cal, 45g protein, 60g carbs, 22g fat')
    expect(stated.calories).toBe(630)
    expect(stated.protein_g).toBe(45)
  })

  it('does not join a comma followed by a space', () => {
    expect(readStatedValues('Calories: 630, 45g protein').calories).toBe(630)
  })
})

describe('metric labels never bind across a line break', () => {
  it('does not read the previous line\'s number as this line\'s metric', () => {
    // Without a newline guard, "671\nFat" matched and fat became 671.
    const stated = readStatedValues('Calories: 671\nFat Total: 35g')
    expect(stated.calories).toBe(671)
    expect(stated.fat_total_g).toBe(35)
  })

  it('still reads a number and label on the same line', () => {
    expect(readStatedValues('47g protein').protein_g).toBe(47)
    expect(readStatedValues('47 g of protein').protein_g).toBe(47)
  })
})
