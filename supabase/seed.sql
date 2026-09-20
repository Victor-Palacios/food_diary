-- Food Log -- seed data. OPTIONAL.
--
-- This only inserts the opening target block (2300 kcal ceiling, 140 g
-- protein, 300 g carbs, 70 g fat, 15 g fiber, effective today). You can skip
-- this file entirely and set the same thing in the app: Settings -> Target
-- history -> New, where those exact numbers are already prefilled.
--
-- Nothing to edit. Paste the whole file into the Supabase SQL editor and run
-- it AFTER creating your account (Authentication -> Users -> Add user).
--
-- The food library is deliberately not seeded -- add the foods of a typical
-- week as you first eat them.

do $$
declare
  uid uuid;
  n   int;
begin
  -- This is a single-user app, so the one account in auth.users is the owner.
  -- No email to fill in, and no way to seed the wrong account by mistake.
  select count(*) into n from auth.users;

  if n = 0 then
    raise exception
      'No account exists yet. Create one first: Authentication -> Users -> '
      '"Add user" (tick Auto Confirm User), then re-run this file.';
  end if;

  if n > 1 then
    raise exception
      'Found % accounts, expected exactly one. This app is single-user; '
      'delete the extras, or insert the target row by hand for the account '
      'you want.', n;
  end if;

  select id into uid from auth.users;

  insert into public.targets
    (owner_id, effective_from, calories_max, protein_g, carbs_g, fat_total_g, fiber_g)
  values
    (uid, current_date, 2300, 140, 300, 70, 15)
  on conflict (owner_id, effective_from) do nothing;

  raise notice 'Opening target seeded for account %.', uid;
end;
$$;
