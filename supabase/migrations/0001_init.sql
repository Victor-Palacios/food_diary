-- Food Log -- initial schema.
--
-- Three concerns, kept separate: what a food IS (foods), what was EATEN
-- (log_entries), and what the TARGETS are (targets).
--
-- The single most important property of this schema: log_entries carry a
-- snapshot of the food's per-serving macros at log time. Correcting a food's
-- macros in week 3 must not silently rewrite weeks 1 and 2, because the 21-day
-- mean gets compared against a DEXA scan months later and has to be
-- reproducible. Never join foods to compute historical totals.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- foods -- the reusable library
-- ---------------------------------------------------------------------------

create table public.foods (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,

  name          text not null check (length(btrim(name)) > 0),
  brand         text,
  serving_label text not null check (length(btrim(serving_label)) > 0),
  serving_grams numeric(10, 2) check (serving_grams is null or serving_grams > 0),

  -- ALL macros are PER ONE SERVING. The multiplier lives on the log entry.
  calories      numeric(10, 2) not null default 0 check (calories >= 0),
  protein_g     numeric(10, 2) not null default 0 check (protein_g >= 0),
  carbs_g       numeric(10, 2) not null default 0 check (carbs_g >= 0),
  fat_total_g   numeric(10, 2) not null default 0 check (fat_total_g >= 0),
  fat_sat_g     numeric(10, 2) not null default 0 check (fat_sat_g >= 0),
  fat_trans_g   numeric(10, 2) not null default 0 check (fat_trans_g >= 0),
  fiber_g       numeric(10, 2) not null default 0 check (fiber_g >= 0),

  source        text not null default 'manual'
                  check (source in ('label', 'restaurant', 'scale', 'photo', 'manual')),
  is_estimate   boolean not null default false,
  archived      boolean not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.foods is
  'Reusable food library. Mutable reference data -- edits here never alter logged history.';
comment on column public.foods.serving_grams is
  'Optional. Enables gram-based entry later; not required for the multiplier model.';
comment on column public.foods.archived is
  'Soft delete. Deleting a food must never orphan or alter history.';
comment on column public.foods.is_estimate is
  'True for anything derived from a photo of a plate, so estimates can be audited or excluded.';

create index foods_owner_active_idx on public.foods (owner_id, archived, name);

-- Trigram-free search: the library tops out around 100 rows, so a plain
-- case-insensitive prefix/substring filter is more than fast enough.
create index foods_owner_name_lower_idx on public.foods (owner_id, lower(name));

-- ---------------------------------------------------------------------------
-- log_entries -- immutable history
-- ---------------------------------------------------------------------------

create table public.log_entries (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,

  eaten_on      date not null,
  eaten_at      timestamptz not null default now(),

  -- null for a one-off entry that was never saved to the library.
  food_id       uuid references public.foods (id) on delete set null,
  label         text not null check (length(btrim(label)) > 0),

  multiplier    numeric(5, 2) not null default 1.00
                  check (multiplier > 0 and multiplier <= 20),

  -- Snapshot of the per-serving values AT LOG TIME.
  s_calories    numeric(10, 2) not null default 0 check (s_calories >= 0),
  s_protein_g   numeric(10, 2) not null default 0 check (s_protein_g >= 0),
  s_carbs_g     numeric(10, 2) not null default 0 check (s_carbs_g >= 0),
  s_fat_total_g numeric(10, 2) not null default 0 check (s_fat_total_g >= 0),
  s_fat_sat_g   numeric(10, 2) not null default 0 check (s_fat_sat_g >= 0),
  s_fat_trans_g numeric(10, 2) not null default 0 check (s_fat_trans_g >= 0),
  s_fiber_g     numeric(10, 2) not null default 0 check (s_fiber_g >= 0),
  s_source      text not null default 'manual'
                  check (s_source in ('label', 'restaurant', 'scale', 'photo', 'manual')),
  s_is_estimate boolean not null default false,

  -- Computed totals. Editing multiplier recomputes this entry and nothing else.
  calories      numeric(12, 2) generated always as (s_calories * multiplier) stored,
  protein_g     numeric(12, 2) generated always as (s_protein_g * multiplier) stored,
  carbs_g       numeric(12, 2) generated always as (s_carbs_g * multiplier) stored,
  fat_total_g   numeric(12, 2) generated always as (s_fat_total_g * multiplier) stored,
  fat_sat_g     numeric(12, 2) generated always as (s_fat_sat_g * multiplier) stored,
  fat_trans_g   numeric(12, 2) generated always as (s_fat_trans_g * multiplier) stored,
  fiber_g       numeric(12, 2) generated always as (s_fiber_g * multiplier) stored,

  note          text
);

comment on table public.log_entries is
  'Immutable history. Carries a snapshot of per-serving macros so historical '
  'aggregates stay reproducible after the food library is corrected.';
comment on column public.log_entries.eaten_on is
  'The day this counts toward, assigned by local midnight in the configured timezone. '
  'Editable for the rare backfill.';

create index log_entries_owner_day_idx on public.log_entries (owner_id, eaten_on);
create index log_entries_owner_food_idx on public.log_entries (owner_id, food_id, eaten_at desc);

-- ---------------------------------------------------------------------------
-- targets -- effective-dated, so historical blocks are not re-scored
-- ---------------------------------------------------------------------------

create table public.targets (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,

  effective_from date not null,
  calories_max   numeric(10, 2) not null check (calories_max > 0),
  protein_g      numeric(10, 2) not null check (protein_g >= 0),
  carbs_g        numeric(10, 2) not null check (carbs_g >= 0),
  fat_total_g    numeric(10, 2) not null check (fat_total_g >= 0),
  fiber_g        numeric(10, 2) not null check (fiber_g >= 0),

  created_at     timestamptz not null default now(),

  -- One target per day per owner; the active one for any date is the greatest
  -- effective_from on or before that date.
  unique (owner_id, effective_from)
);

comment on table public.targets is
  'Effective-dated targets. They move by 100 kcal every scan cycle, so old blocks '
  'must keep being scored against the target that was live at the time.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger foods_set_updated_at
  before update on public.foods
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Aggregate views
-- ---------------------------------------------------------------------------

-- Per-day totals. A day with no entries simply has no row here, which is
-- exactly what the mean/median need: unlogged days are absent, never zero.
create view public.daily_totals
with (security_invoker = true) as
select
  owner_id,
  eaten_on,
  count(*)::int                  as entry_count,
  sum(calories)                  as calories,
  sum(protein_g)                 as protein_g,
  sum(carbs_g)                   as carbs_g,
  sum(fat_total_g)               as fat_total_g,
  sum(fat_sat_g)                 as fat_sat_g,
  sum(fat_trans_g)               as fat_trans_g,
  sum(fiber_g)                   as fiber_g,
  bool_or(s_is_estimate)         as has_estimate
from public.log_entries
group by owner_id, eaten_on;

comment on view public.daily_totals is
  'One row per logged day. Unlogged days are absent by construction -- never zero.';

-- Drives picker ordering. Recency first is what makes the repeat-food flow fast.
create view public.food_usage
with (security_invoker = true) as
select
  owner_id,
  food_id,
  count(*)::int      as use_count,
  max(eaten_at)      as last_eaten_at
from public.log_entries
where food_id is not null
group by owner_id, food_id;

comment on view public.food_usage is
  'Usage stats per food, used to sort the picker so repeat foods surface first.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- This is a single-user app; RLS is the second layer behind Supabase Auth.
-- Scoping to auth.uid() rather than "any authenticated user" means a stray
-- account, if one is ever created, still sees nothing.

alter table public.foods       enable row level security;
alter table public.log_entries enable row level security;
alter table public.targets     enable row level security;

create policy foods_owner_select on public.foods
  for select to authenticated using (auth.uid() = owner_id);
create policy foods_owner_insert on public.foods
  for insert to authenticated with check (auth.uid() = owner_id);
create policy foods_owner_update on public.foods
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy foods_owner_delete on public.foods
  for delete to authenticated using (auth.uid() = owner_id);

create policy log_entries_owner_select on public.log_entries
  for select to authenticated using (auth.uid() = owner_id);
create policy log_entries_owner_insert on public.log_entries
  for insert to authenticated with check (auth.uid() = owner_id);
create policy log_entries_owner_update on public.log_entries
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy log_entries_owner_delete on public.log_entries
  for delete to authenticated using (auth.uid() = owner_id);

create policy targets_owner_select on public.targets
  for select to authenticated using (auth.uid() = owner_id);
create policy targets_owner_insert on public.targets
  for insert to authenticated with check (auth.uid() = owner_id);
create policy targets_owner_update on public.targets
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy targets_owner_delete on public.targets
  for delete to authenticated using (auth.uid() = owner_id);

-- Views inherit the base table's RLS through security_invoker, but they still
-- need the grant.
grant select on public.daily_totals to authenticated;
grant select on public.food_usage to authenticated;

-- Nothing is reachable without a session.
revoke all on public.foods, public.log_entries, public.targets from anon;
revoke all on public.daily_totals, public.food_usage from anon;
