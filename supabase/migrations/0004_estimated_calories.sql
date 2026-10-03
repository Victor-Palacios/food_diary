-- How much of a day's calories were estimated, not just whether any were.
--
-- Every entry already records s_is_estimate: true for a plate photo or a
-- description the model had to guess at, false for figures read from a label,
-- a restaurant's published numbers, or the user's own scale. The column was
-- added "so estimates can be audited or excluded", but the only thing the view
-- passed on was has_estimate, a per-day yes/no, and nothing displayed even
-- that. The audit was never built.
--
-- A yes/no per day cannot carry the audit. One estimated banana and an
-- estimated restaurant dinner both make has_estimate true, and they say very
-- different things about how far a 21-day mean can be trusted against a DEXA
-- scan. So the view now reports the estimated calories themselves, and the
-- dashboard states their share of the block.
--
-- This recreates the whole view, so it includes 0003's fiber change: running
-- this file alone is enough, whether or not 0003 was run first.

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
  -- From 0003: the fiber that was recorded, unrecorded entries counting as 0.
  coalesce(sum(fiber_g), 0)      as fiber_g,
  count(fiber_g)::int            as fiber_entry_count,
  bool_or(s_is_estimate)         as has_estimate,
  -- The calories on estimated entries. coalesce covers the usual day, where
  -- nothing was estimated and the filtered sum is NULL rather than 0.
  coalesce(sum(calories) filter (where s_is_estimate), 0) as estimated_calories,
  (count(*) filter (where s_is_estimate))::int            as estimate_entry_count
from public.log_entries
group by owner_id, eaten_on;

comment on view public.daily_totals is
  'One row per logged day. Unlogged days are absent by construction -- never '
  'zero. fiber_g sums the entries that recorded fiber and counts the rest as '
  'zero; compare fiber_entry_count with entry_count to see the coverage. '
  'estimated_calories is the part of calories that came from estimated entries.';

grant select on public.daily_totals to authenticated;
revoke all on public.daily_totals from anon;
