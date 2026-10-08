#!/usr/bin/env node
/**
 * Weekly summary email: read the log, compute the 21-day summary, send it.
 *
 *   node scripts/summary/send.mjs                    send it now
 *   node scripts/summary/send.mjs --dry-run          write the email to summary.html instead
 *   node scripts/summary/send.mjs --dry-run --out=x.html --end=2026-10-09
 *
 * Environment (GitHub Actions secrets in the workflow):
 *   SUPABASE_URL, SUPABASE_ANON_KEY   the same two values the app is built with
 *   FOOD_LOG_PASSWORD                 the app's sign-in password
 *   FOOD_LOG_EMAIL                    the app's sign-in email (defaults to GMAIL_USER)
 *   GMAIL_USER, GMAIL_APP_PASSWORD    the Gmail account it sends from, and to
 *   SUMMARY_TO                        optional, a different recipient
 *
 * It reads with the app's own account, so Row Level Security applies exactly
 * as it does in the app. The service_role key is never used.
 *
 * The repository is public, and so are its Actions logs. Nothing from the log
 * -- no food, no figure -- is ever printed here; only dates and outcomes.
 */

import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import { BLOCK_DAYS, addDays, computeSummary, localDate } from './compute.mjs'
import { renderEmail, renderText, subject } from './render.mjs'

export const TIME_ZONE = 'America/Los_Angeles'
export const SEND_HOUR = 8

/** Hours east of UTC in a timezone at a moment: -7 for PDT, -8 for PST. */
export function utcOffsetHours(at, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(name)
  return m ? Number(m[1]) + Math.sign(Number(m[1])) * Number(m[2] ?? 0) / 60 : 0
}

/**
 * GitHub's cron is UTC only, and 8am in California is 15:00 UTC in summer and
 * 16:00 in winter. The workflow schedules both; this keeps only the one that
 * is 8am locally. It decides by which cron fired, not by the clock, because a
 * scheduled run can start well after its time and must still not be dropped,
 * or doubled. Anything other than a scheduled run (a manual run) always goes.
 */
export function shouldSend({ event, schedule, now, timeZone = TIME_ZONE, hour = SEND_HOUR }) {
  if (event !== 'schedule') return { send: true, reason: 'not a scheduled run' }
  const utcHour = (((hour - utcOffsetHours(now, timeZone)) % 24) + 24) % 24
  const fired = /^\s*\d+\s+(\d+)\s/.exec(schedule ?? '')?.[1]
  return Number(fired) === utcHour
    ? { send: true, reason: `${schedule} is ${hour}:00 in ${timeZone} today` }
    : { send: false, reason: `${schedule} is not ${hour}:00 in ${timeZone} at this time of year; the other schedule covers it` }
}

function parseArgs(argv) {
  const args = { dryRun: false, out: 'summary.html', end: null }
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true
    else if (a.startsWith('--out=')) args.out = a.slice(6)
    else if (a.startsWith('--end=')) args.end = a.slice(6)
    else throw new Error(`Unknown argument: ${a}`)
  }
  return args
}

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} as repository secrets (see the README).`)
  }
}

/** Fetches what the summary needs, as the app's own user. */
export async function fetchRows(supabase, start, end) {
  const [entries, first, targets, meals] = await Promise.all([
    supabase.from('log_entries').select('*').gte('eaten_on', start).lte('eaten_on', end).order('eaten_at'),
    supabase.from('log_entries').select('eaten_on').order('eaten_on').limit(1),
    supabase.from('targets').select('*'),
    supabase.from('meals').select('name, meal_items(food_id)'),
  ])
  for (const [what, r] of [['entries', entries], ['first entry', first], ['targets', targets]]) {
    if (r.error) throw new Error(`Could not read ${what}: ${r.error.message}`)
  }
  return {
    entries: entries.data ?? [],
    firstEver: first.data?.[0]?.eaten_on ?? null,
    targets: targets.data ?? [],
    // Saved meals arrive with migration 0005. Without it the summary simply
    // leaves out the meal callout.
    meals: meals.error
      ? null
      : (meals.data ?? []).map((m) => ({ name: m.name, foodIds: (m.meal_items ?? []).map((i) => i.food_id) })),
  }
}

export function buildMessage(summary, { from, to }) {
  return {
    from: `Food Log <${from}>`,
    to,
    subject: subject(summary),
    text: renderText(summary),
    html: renderEmail(summary),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const now = new Date()

  const gate = shouldSend({ event: process.env.GITHUB_EVENT_NAME, schedule: process.env.SCHEDULE, now })
  if (!gate.send) {
    console.log(`Skipping: ${gate.reason}.`)
    return
  }

  requireEnv(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'FOOD_LOG_PASSWORD'])
  if (!args.dryRun) requireEnv(['GMAIL_USER', 'GMAIL_APP_PASSWORD'])
  const email = process.env.FOOD_LOG_EMAIL || process.env.GMAIL_USER
  if (!email) throw new Error('Missing FOOD_LOG_EMAIL (or GMAIL_USER to default it to).')

  // Yesterday in California, so every day in the block is complete.
  const end = args.end ?? addDays(localDate(now, TIME_ZONE), -1)
  const start = addDays(end, -(BLOCK_DAYS - 1))

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: process.env.FOOD_LOG_PASSWORD })
  if (signInError) throw new Error(`Could not sign in to the Food Log: ${signInError.message}`)

  try {
    const rows = await fetchRows(supabase, start, end)
    const summary = computeSummary({ ...rows, end })
    const message = buildMessage(summary, { from: process.env.GMAIL_USER ?? email, to: process.env.SUMMARY_TO || process.env.GMAIL_USER || email })

    if (args.dryRun) {
      writeFileSync(args.out, message.html)
      console.log(`Wrote the summary for ${start} to ${end} to ${args.out}. Nothing was sent.`)
      return
    }

    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
    await transport.sendMail(message)
    console.log(`Sent the summary for ${start} to ${end}.`)
  } finally {
    await supabase.auth.signOut().catch(() => {})
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    // The message names what failed; it never carries data from the log.
    console.error(`Weekly summary failed: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  })
}
