-- Food Log -- seed data.
--
-- Run this ONCE, after creating the single user account (see README ->
-- "Supabase setup"). It attaches the opening target block to that account.
--
-- EDIT THIS LINE, then run the whole file in the Supabase SQL editor
-- (or: psql "$DATABASE_URL" -f supabase/seed.sql).

do $$
declare
  owner_email constant text := 'you@example.com';  -- <-- edit me
  uid uuid;
begin
  select id into uid from auth.users where email = owner_email;

  if uid is null then
    raise exception
      'No auth.users row for %. Create the single account first, then re-run this file.',
      owner_email;
  end if;

  -- Opening targets for the current block (spec section 1). These move by
  -- 100 kcal every DEXA cycle -- edit them in the app from then on, never
  -- here, so each change lands as its own effective-dated row.
  insert into public.targets
    (owner_id, effective_from, calories_max, protein_g, carbs_g, fat_total_g, fiber_g)
  values
    (uid, current_date, 2300, 140, 300, 70, 15)
  on conflict (owner_id, effective_from) do nothing;

  raise notice 'Seeded targets for % (%).', owner_email, uid;
end;
$$;
