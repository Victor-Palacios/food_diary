-- A day's fiber total becomes the fiber actually recorded, not nothing.
--
-- 0002 made a day's fiber NULL unless EVERY entry that day recorded it. The
-- reasoning was sound in isolation -- a partial sum passed off as a whole day
-- reads low without saying so -- but in practice it hid the data entirely.
--
-- Measured on the real log: 152 foods, 3 with fiber. One day, six entries, two
-- of them carrying 11 g and 10 g. The day reported NULL, so 21 g of recorded
-- fiber showed as a dash on the Today screen and was excluded from every
-- average. The strictness did not protect a number, it deleted one.
--
-- So sum what is known and treat unrecorded as zero, which is what sum()
-- already does with NULLs -- coalesce only covers the all-NULL day. The
-- honesty that mattered is kept by reporting coverage instead of withholding
-- the figure: fiber_entry_count against entry_count tells the UI how much of
-- the day the number is based on, and it says so next to it.
--
-- Storage is unchanged. foods.fiber_g and log_entries.s_fiber_g stay nullable,
-- because "not recorded" and "measured zero" are still different facts about a
-- food and only one of them should be corrected later. This is a reporting
-- decision, not a data one.

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
  -- sum() skips NULLs, so this is the fiber that was recorded. coalesce is
  -- only for a day where nothing recorded any, which reads as 0 g rather
  -- than as a gap the UI has to special-case.
  coalesce(sum(fiber_g), 0)      as fiber_g,
  -- How much of the day that figure covers. Not cosmetic: it is the
  -- difference between "ate 21 g" and "ate at least 21 g".
  count(fiber_g)::int            as fiber_entry_count,
  bool_or(s_is_estimate)         as has_estimate
from public.log_entries
group by owner_id, eaten_on;

comment on view public.daily_totals is
  'One row per logged day. Unlogged days are absent by construction -- never '
  'zero. fiber_g sums the entries that recorded fiber and counts the rest as '
  'zero; compare fiber_entry_count with entry_count to see the coverage.';

grant select on public.daily_totals to authenticated;
revoke all on public.daily_totals from anon;
