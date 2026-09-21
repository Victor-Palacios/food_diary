-- Fiber becomes optional: NULL means "not recorded", which is not the same
-- as zero.
--
-- Most real sources simply do not print fiber. Storing a 0 for those makes an
-- unknown indistinguishable from a genuine zero, and the fiber average then
-- reads low without ever saying why -- the same failure the 21-day mean
-- avoids by excluding unlogged days rather than counting them as 0.
--
-- Every other metric stays NOT NULL. Calories and the macros are always on a
-- label or a scale; fiber is the one that routinely is not.

alter table public.foods
  alter column fiber_g drop not null,
  alter column fiber_g drop default;

alter table public.log_entries
  alter column s_fiber_g drop not null,
  alter column s_fiber_g drop default;

comment on column public.foods.fiber_g is
  'NULL means not recorded. Distinct from 0, which means a measured zero.';
comment on column public.log_entries.s_fiber_g is
  'NULL means not recorded at log time. The generated total is NULL to match.';

-- The generated total follows automatically: NULL * multiplier is NULL, so an
-- entry with unrecorded fiber contributes an unknown rather than a zero.

-- ---------------------------------------------------------------------------
-- daily_totals has to stop summing around the gaps
-- ---------------------------------------------------------------------------
-- sum() skips NULLs, so a day with three known entries and one unknown would
-- report the three as if they were the whole day. A day's fiber is therefore
-- known only when EVERY entry that day recorded it; otherwise the day is
-- unknown and the dashboard leaves it out of the average and says so.

drop view if exists public.daily_totals;

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
  case
    when bool_and(fiber_g is not null) then sum(fiber_g)
  end                            as fiber_g,
  count(fiber_g)::int            as fiber_entry_count,
  bool_or(s_is_estimate)         as has_estimate
from public.log_entries
group by owner_id, eaten_on;

comment on view public.daily_totals is
  'One row per logged day. Unlogged days are absent by construction -- never '
  'zero. fiber_g is NULL unless every entry that day recorded fiber.';

grant select on public.daily_totals to authenticated;
revoke all on public.daily_totals from anon;
