# Food Log

Single-user food logging. Phone-first, installable, backed by Supabase, served
by one Cloudflare Worker.

This is not a live nutrition dashboard. It is an adherence device. Its only job
is to survive 21 consecutive days of logging on a phone and then produce one
trustworthy number — the mean and median daily calories over the block — to
compare against a DEXA scan.

**Acceptance criterion:** on a phone, one-handed, log a repeat food with a
non-default multiplier in under 10 seconds from app open to saved. The built
flow is four taps with no typing: `Log` → the food (recents sort first) → a
multiplier preset → `Save`.

---

## Contents

- [Stack](#stack)
- [Auth](#auth-supabase-auth-single-seeded-account)
- [Supabase setup](#supabase-setup)
- [Row Level Security](#row-level-security)
- [Cloudflare Workers deploy](#cloudflare-workers-deploy)
- [Secrets](#secrets)
- [Local development](#local-development)
- [Phase 2: photo and text extraction](#phase-2-photo-and-text-extraction)
- [Data model notes](#data-model-notes)
- [Project layout](#project-layout)

---

## Stack

| Layer | Choice |
|---|---|
| Hosting | Cloudflare Workers with static assets (**not** Pages) |
| Build | Workers Builds, triggered on push to GitHub |
| Client | Vite + React + TypeScript, no UI framework |
| Data | Supabase (Postgres + RLS) |
| Auth | Supabase Auth, one seeded account |
| PWA | `vite-plugin-pwa`, installable, app shell precached |

One Worker serves both the SPA and the API. Static assets in `dist/` are matched
first; `run_worker_first: ["/api/*"]` carves out the API routes so they reach
the script, and `not_found_handling: "single-page-application"` sends every
other unmatched path to `index.html` so client-side routes survive a refresh.

---

## Auth: Supabase Auth, single seeded account

**Chosen over Cloudflare Access**, deliberately.

Cloudflare Access is the lower-effort option on paper, but its default
single-user flow is an email one-time PIN. That means a mail round-trip in front
of the app, and in an installed PWA it means bouncing out to a browser and back.
The product is held to a ten-second budget from app open to saved; an auth
handshake at launch spends the whole thing.

Supabase Auth with a persisted session means the sign-in screen is seen once and
then effectively never again, and it gives RLS a real principal to scope to — so
the second layer actually has teeth rather than trusting "any authenticated
user".

There is no signup flow, no password reset UI, and no custom auth code.

### Create the single account

Supabase dashboard → **Authentication** → **Users** → **Add user** →
*Create new user*. Set the email and a strong password, and tick
*Auto Confirm User*.

Then close the door behind you — Authentication → **Sign In / Providers**:

- turn **Allow new users to sign up** off,
- leave **Confirm email** on,
- disable every OAuth provider.

With signups off, the account you just made is the only one that can ever exist.

### Rotate the credential

Dashboard → Authentication → Users → the user → **Reset password** (or
*Send password recovery*). The change takes effect immediately; existing
sessions keep working until their refresh token expires, so to force a full
logout use **Sign out user** on the same menu afterward.

There is no in-app password change on purpose: it would be UI that exists for
one event a year and another surface to get wrong.

---

## Supabase setup

No CLI needed — all of this can be done in the browser at
[supabase.com/dashboard](https://supabase.com/dashboard).

1. **Create the project.** New project → pick any name → set a database
   password (this is the *database* password, not your login to the app; save
   it in a password manager and otherwise forget it) → pick the region closest
   to you. It takes a minute or two to provision.

2. **Create the tables.** Left sidebar → **SQL Editor** → *New query*. Paste
   the entire contents of `supabase/migrations/0001_init.sql` and press **Run**.
   You should see "Success. No rows returned" — that is what success looks like
   for DDL.

   This creates `foods`, `log_entries`, `targets`, the `daily_totals` and
   `food_usage` views, and enables RLS with owner-scoped policies on all three
   tables.

   With the CLI instead, if you prefer:

   ```sh
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

3. **Create your one account.** Authentication → **Users** → *Add user* →
   *Create new user*. Enter the email and password you will actually sign in
   to the app with, and **tick Auto Confirm User** — without it the account
   stays unverified and cannot sign in.

4. **Close the door.** Authentication → **Sign In / Providers**: turn
   **Allow new users to sign up** off, leave *Confirm email* on, and disable
   every OAuth provider. The account from step 3 is now the only one that can
   ever exist.

5. **Copy the two values the app needs.** Project Settings → **API Keys**:
   the **Project URL** and the **anon / publishable** key. You will paste these
   into Cloudflare later. Do *not* copy the `service_role` key — this project
   never uses it.

6. **Set the opening target.** **Either** do it in the app once it is running —
   Settings → Target history → **New**, where 2300 / 140 / 300 / 70 / 15 are
   already prefilled — **or** paste `supabase/seed.sql` into the SQL editor and
   run it. There is nothing to edit in that file; it finds the single account
   itself and errors out rather than guessing if there is not exactly one.

   Either way it lands as one effective-dated row. Every later change is made
   in the app, so each one becomes its own row and old blocks keep their
   original target.

The food library is intentionally not seeded. Add the twenty foods of a typical
week as you first eat them.

---

## Row Level Security

**RLS is enabled on every table.** This is not optional: the anon key ships in
the client bundle by design, and with RLS off that key would be an unrestricted
read/write credential published in your JavaScript.

| Object | Protection |
|---|---|
| `foods` | RLS enabled, 4 policies |
| `log_entries` | RLS enabled, 4 policies |
| `targets` | RLS enabled, 4 policies |
| `daily_totals` (view) | `security_invoker = true` — inherits `log_entries` RLS |
| `food_usage` (view) | `security_invoker = true` — inherits `log_entries` RLS |

Every table carries `owner_id uuid not null default auth.uid()`, and each of the
four policies per table is the same shape:

```sql
create policy foods_owner_select on public.foods
  for select to authenticated using (auth.uid() = owner_id);
create policy foods_owner_insert on public.foods
  for insert to authenticated with check (auth.uid() = owner_id);
create policy foods_owner_update on public.foods
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy foods_owner_delete on public.foods
  for delete to authenticated using (auth.uid() = owner_id);
```

`owner_id` is a small addition to the schema in the spec. It is what makes the
second layer meaningful: a policy of `to authenticated using (true)` would grant
everything to any account that ever comes into existence, whereas scoping to
`auth.uid()` fails closed. The client never sets it — the column default does.

The `anon` role is explicitly revoked from all three tables and both views, so
nothing is reachable without a session.

To verify after deploying, in the SQL editor:

```sql
select relname, relrowsecurity
from pg_class
where relname in ('foods', 'log_entries', 'targets');
-- all three must show relrowsecurity = true
```

---

## Cloudflare Workers deploy

`wrangler.jsonc` is committed and holds binding names and non-sensitive config
only.

### Connect Workers Builds to GitHub

Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a
repository** → pick this repo. Then set:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

Every push to the connected branch builds and deploys.

### Build-time variables

Set these in the Worker's **Settings → Variables and Secrets** as *plaintext*
build variables. They are inlined into the client bundle — see
[Secrets](#secrets) for why that is fine for these two and never for anything
else.

```
VITE_SUPABASE_URL       https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY  <anon key>
VITE_TIMEZONE           America/Los_Angeles
```

`VITE_TIMEZONE` is the single fixed timezone that defines the day boundary. It
defaults to `America/Los_Angeles` when unset.

### Deploying by hand

```sh
npm run deploy      # builds, then wrangler deploy
```

---

## Secrets

**Nothing secret is committed to this repo.** Not in `wrangler.jsonc`, not in a
`.env`, not in a seed script, not temporarily. Git history and forks make a
committed secret permanent — rotation is the only remedy.

| Credential | Lives in | Reaches the browser? |
|---|---|---|
| Supabase anon key | client bundle (build variable) | **Yes — by design** |
| Supabase `service_role` key | not used by this project at all | Never |
| NVIDIA API key (Phase 2) | Worker secret binding | Never |
| Account password | Supabase Auth | Never |

### The two Supabase keys are not interchangeable

- The **anon key is public.** It is meant to ship in the client bundle. It is
  safe *only* because RLS is enabled on every table and every policy scopes to
  `auth.uid()`.
- The **`service_role` key bypasses RLS completely.** This project never uses
  it. All database access happens from the browser under RLS, so the key is not
  needed and is deliberately not wired up anywhere — the Worker holds no
  database credentials at all.

### There is no such thing as a build-time secret in a frontend bundle

Anything a bundler inlines ends up in the shipped JavaScript, whether it came
from `.env.local` or from a Cloudflare build variable. Setting a value in the
Cloudflare dashboard does not make it private. Only server-side execution does.
That is the entire reason Phase 2 calls NVIDIA from the Worker instead of the
browser.

### Setting a runtime secret

```sh
npx wrangler secret put NVIDIA_API_KEY
```

Encrypted at rest, injected as an environment binding, not readable back from
the dashboard. Locally, the same value goes in `.dev.vars` (gitignored; see
`.dev.vars.example`).

If a secret is ever committed, rotate it. Do not rely on deleting the commit.

---

## Local development

```sh
npm install
cp .env.example .env.local     # fill in your dev Supabase URL + anon key
npm run dev                    # http://localhost:5173
```

Point `.env.local` at a **separate dev Supabase project**, set up exactly as
above (migration + seed + signups disabled + its own user). Nothing in the app
distinguishes dev from production, so sharing one project means logging test
food into the block you are about to compare against a scan.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR. Does not run the Worker. |
| `npm test` | Vitest — the aggregation, date and formatting logic |
| `npm run typecheck` | `tsc -b` across app, worker and node configs |
| `npm run build` | Typecheck, then build the SPA into `dist/` |
| `npm run dev:worker` | Build, then `wrangler dev` — the real Worker + assets |
| `npm run deploy` | Build, then `wrangler deploy` |
| `npm run icons` | Regenerate the PWA icons (output is committed) |

`npm run dev` does not run the Worker, so `/api/*` is proxied to
`http://127.0.0.1:8787`. To work on Phase 2 with hot reload, run both:

```sh
npx wrangler dev      # terminal 1 — serves /api/*
npm run dev           # terminal 2 — serves the SPA, proxies /api to 8787
```

For anything in Phase 1, `npm run dev` alone is enough.

### Tests

`npm test` covers the parts where a bug would be silent rather than loud: the
block aggregation (including the unlogged-days rule), calendar arithmetic across
DST and month boundaries, and multiplier parsing and rendering.

---

## Phase 2: photo and text extraction

Optional, and shipped in a state where an unconfigured deployment is a fully
supported one. With no `NVIDIA_API_KEY` set, `/api/extract` returns 501, the
client hides the camera buttons entirely, and Phase 1 behaves exactly as before.

Three separate features, not one "upload a picture" flow:

- **Label OCR** (`kind: "label"`), on the food form. Reads a printed nutrition
  panel and prefills a new library row. Accurate, because it is reading text.
- **Plate estimation** (`kind: "plate"`), on the one-off entry form. Estimates
  an unlabelled plate from a photo. Written with `source = 'photo'` and
  `is_estimate = true`, and the UI labels it an estimate.
- **Text** (`kind: "text"`), also on the one-off entry form, and in practice
  the most useful of the three. It covers two cases and tells them apart
  itself, so there is no mode to choose:

  | You type | It does | Recorded as |
  |---|---|---|
  | `Chicken bowl, 630 cal, 45g protein, 60g carbs, 22g fat` | Transcribes your figures verbatim, 0 for anything unstated | `is_estimate = false`, `source = 'restaurant'` |
  | `2 eggs and toast with butter` | Estimates the whole portion | `is_estimate = true`, `source = 'manual'` |

  That distinction matters: ~80% of intake comes from labels or published
  restaurant data, and filing those exact figures as guesses would make real
  data excludable from analysis later.

  **It is not left to the model to decide.** Models were observed reporting
  an exact list of macros as an estimate, and rounding the figures while they
  were at it. So the Worker reads the numbers out of the description itself
  (`readStatedValues`), overwrites the model's values with any the user
  stated, and sets `is_estimate = false` when calories, protein, carbs and
  fat were all given. Saturated and trans fat are excluded from that test,
  since labels routinely omit them and their absence should not demote an
  otherwise exact entry. Where the user stated nothing, the model's own
  `estimated` flag stands, and anything other than a literal `false` counts
  as an estimate.

  A figure the user typed is ground truth, so transcribing it is something
  the app can simply do itself rather than hope for.

  `source = 'photo'` is reserved for results that actually came from a camera,
  so provenance stays honest.

Text requests are routed to `NVIDIA_TEXT_MODEL` rather than the vision model —
cheaper, and better at following the transcribe-versus-estimate rule, which is
the part that has to be right. Both model ids are non-secret `vars` in
`wrangler.jsonc` and can be changed without a code change.

### When a model is withdrawn

NVIDIA retires hosted models, and a retired id answers **410 Gone** forever.
The live catalog is public and needs no key:

```sh
curl https://integrate.api.nvidia.com/v1/models
```

Two things keep that from breaking the feature:

- On a 404/410 for the text model, the Worker **falls back to the vision
  model**, which handles plain text fine. Slightly dearer per call, but the
  feature keeps working. The swap is logged.
- If nothing works, the error names the dead model and the variable to
  change, rather than saying "try again".

### Timeouts, and why the reply is streamed

Cloudflare's edge abandons a request that has produced no bytes for around
100 seconds and returns a bare **524**. Raising the Worker's own timeout past
that buys nothing — it just replaces a useful error with an opaque one.

So `/api/extract` streams. The response is newline-delimited: lines starting
with `:` are heartbeats sent every 10s, and the final line carries the
outcome. A connection that keeps emitting bytes is never idle, so the model
gets the full **5-minute** budget, shared across any fallback retry.

One consequence worth knowing: the HTTP status is fixed when the headers go
out, long before the outcome is known, so a streamed reply is always `200`
and success is carried in the body as `{ "ok": true, ... }` or
`{ "ok": false, "error": ... }`. Validation failures happen before streaming
starts and keep ordinary status codes (400, 413, 501).

The buttons show elapsed seconds while waiting, because a minute of silence
is indistinguishable from a hang.

Photos are compressed client-side to keep the base64 payload under ~150 KB,
stepping down through size and quality until it fits. NVIDIA's vision
endpoints accept an inline image only up to about 180 KB, and going over does
not fail cleanly — the request can simply hang. The Worker rejects anything
over the limit with a clear message as a backstop.

All three are **review-before-save**: the model prefills a form, the user
confirms every value. Nothing is ever written to the log directly — the Worker
has no database access to do it with even if it wanted to.

The typed description is sent as its own message part rather than spliced into
the prompt, so nothing the user types is read as further instructions.

Photos are downscaled to 1280px and JPEG-compressed in the browser before
upload, which also strips EXIF.

Configure with:

```sh
npx wrangler secret put NVIDIA_API_KEY
```

The model and base URL are non-sensitive and live in `wrangler.jsonc` under
`vars`, so they can be changed without touching code.

---

## Data model notes

Three concerns, kept separate: what a food **is**, what was **eaten**, and what
the **targets** are.

**Macros are stored per one serving, always.** The quantity lives on the log
entry as a decimal `multiplier` (`> 0`, capped at 20, enforced by a database
CHECK). Two package sizes are two rows, deliberately — modelling package
variants is not worth the complexity at twenty foods a week.

**Log entries snapshot the food's macros at log time.** `log_entries` carries
`s_calories`, `s_protein_g` and so on, and the totals are generated columns
(`s_calories * multiplier`). Correcting a food in week 3 must not silently
rewrite weeks 1 and 2, because the 21-day mean has to be reproducible months
later. Historical totals are never computed by joining `foods`.

**Unlogged days are excluded from the mean and median, not counted as zero.** A
missed day read as a 0-calorie day drags a 21-day mean down by roughly 110 kcal
— the same size as the adjustment step — which would make the app lie about the
one number it exists to produce. The `daily_totals` view has no row for a day
with no entries, the aggregation only ever averages the days present, and the
block view states `N / 21` prominently and warns when any are missing.

**Targets are effective-dated.** The active target for a date is the row with
the greatest `effective_from` on or before it, so dropping the ceiling by 100
kcal never re-scores a block that was already logged.

**Days are bounded by local midnight** in one fixed timezone (`VITE_TIMEZONE`).
All date arithmetic works on `YYYY-MM-DD` strings in UTC, so a DST transition
cannot shift which day a meal counted toward. `eaten_on` is editable for the
rare backfill.

---

## Project layout

```
index.html                 SPA entry
wrangler.jsonc             Worker config: assets, routing, non-secret vars
vite.config.ts             Build + PWA manifest + /api dev proxy

worker/
  index.ts                 Routes /api/*, falls back to static assets
  extract.ts               Phase 2: NVIDIA proxy, prompts, JSON recovery
  shared.ts                Env bindings and the JSON helper

src/
  lib/
    config.ts              Build-time config (public values only)
    supabase.ts            Client, persisted session
    types.ts               The seven metrics and the row shapes
    dates.ts               Calendar days in the fixed timezone
    stats.ts               Mean/median; the unlogged-days rule
    api.ts                 All reads and writes
    extract.ts             Phase 2 client: compress, post, normalize
    AppData.tsx            Shared foods + targets
    logic.test.ts          Unit tests
  components/              AuthGate, Sheet, MultiplierPicker, forms, icons
  pages/                   Today, Foods, Dashboard, Settings

supabase/
  migrations/0001_init.sql Schema, views, RLS
  seed.sql                 Opening targets

scripts/generate-icons.mjs PNG icon generator (no image dependency)
```

### Out of scope, on purpose

Barcode scanning, recipes and multi-ingredient composition, weight/DEXA entry,
streaks and notifications, sharing and export, multi-user, offline-first sync
with conflict resolution, and micronutrients beyond the seven tracked.
