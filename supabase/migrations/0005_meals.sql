-- Saved meals: log a fixed combination of library foods in one go.
--
-- The usual breakfast -- steel cut oats, flaxseed, four servings of fruit, a
-- scoop of protein -- was four separate trips through the picker every
-- morning. The app's one job is surviving 21 days of phone logging, and the
-- most frequent meal costing four logs is the largest piece of friction left.
--
-- A meal is a shortcut, not a recipe. It holds no nutrition of its own: only
-- which foods, and how many servings of each. Logging it writes one ordinary
-- log entry per food, each with its own snapshot taken at that moment, exactly
-- as if the foods had been logged one at a time. So nothing downstream -- the
-- daily totals, fiber coverage, the estimated share -- knows or cares that a
-- meal was involved, and a correction to a food reaches the meal the next time
-- it is logged without ever reaching back into history.
--
-- Independent of 0003 and 0004: those only redefine the daily_totals view.
--
-- The end of this file creates "Usual breakfast" for the one account, from
-- foods found by name. It skips itself, with a notice, rather than failing the
-- migration if the account or any of those foods is missing, and does nothing
-- if a meal by that name already exists. Every statement above it is written
-- to be re-runnable too, so pasting this file in twice is harmless.

create table if not exists public.meals (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now(),

  -- Two meals with one name would be indistinguishable in the picker.
  unique (owner_id, name)
);

comment on table public.meals is
  'A named combination of library foods, logged in one go as one entry per food. '
  'Holds no nutrition itself; each entry snapshots its food when logged.';

create table if not exists public.meal_items (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meal_id    uuid not null references public.meals (id) on delete cascade,
  -- Foods are archived, never deleted, so this cascade is for a hard delete
  -- done by hand. An archived food stays in the meal and the app skips it.
  food_id    uuid not null references public.foods (id) on delete cascade,
  multiplier numeric(5, 2) not null default 1.00
               check (multiplier > 0 and multiplier <= 20),
  -- Display order: the order the foods were chosen in.
  position   int not null default 0,

  unique (meal_id, food_id)
);

comment on table public.meal_items is
  'The usual servings of each food in a meal. Adjustable at log time; this '
  'is only the default.';

create index if not exists meal_items_meal_idx on public.meal_items (meal_id, position);

-- ---------------------------------------------------------------------------
-- Row level security -- the same owner-only scoping as every other table
-- ---------------------------------------------------------------------------

alter table public.meals      enable row level security;
alter table public.meal_items enable row level security;

drop policy if exists meals_owner_select on public.meals;
create policy meals_owner_select on public.meals
  for select to authenticated using (auth.uid() = owner_id);
drop policy if exists meals_owner_insert on public.meals;
create policy meals_owner_insert on public.meals
  for insert to authenticated with check (auth.uid() = owner_id);
drop policy if exists meals_owner_update on public.meals;
create policy meals_owner_update on public.meals
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists meals_owner_delete on public.meals;
create policy meals_owner_delete on public.meals
  for delete to authenticated using (auth.uid() = owner_id);

-- An item must belong to the caller AND point at the caller's own meal and
-- food. Foreign keys are checked without RLS, so owner_id alone would let a
-- row reference someone else's meal or food by id.
drop policy if exists meal_items_owner_select on public.meal_items;
create policy meal_items_owner_select on public.meal_items
  for select to authenticated using (auth.uid() = owner_id);
drop policy if exists meal_items_owner_insert on public.meal_items;
create policy meal_items_owner_insert on public.meal_items
  for insert to authenticated with check (
    auth.uid() = owner_id
    and exists (select 1 from public.meals m where m.id = meal_id and m.owner_id = auth.uid())
    and exists (select 1 from public.foods f where f.id = food_id and f.owner_id = auth.uid())
  );
drop policy if exists meal_items_owner_update on public.meal_items;
create policy meal_items_owner_update on public.meal_items
  for update to authenticated using (auth.uid() = owner_id) with check (
    auth.uid() = owner_id
    and exists (select 1 from public.meals m where m.id = meal_id and m.owner_id = auth.uid())
    and exists (select 1 from public.foods f where f.id = food_id and f.owner_id = auth.uid())
  );
drop policy if exists meal_items_owner_delete on public.meal_items;
create policy meal_items_owner_delete on public.meal_items
  for delete to authenticated using (auth.uid() = owner_id);

grant select, insert, update, delete on public.meals, public.meal_items to authenticated;
revoke all on public.meals, public.meal_items from anon;

-- ---------------------------------------------------------------------------
-- The usual breakfast
-- ---------------------------------------------------------------------------
-- Matched by name against the library, the way it was actually logged:
-- "protein powder" rather than the identical but never-used
-- "protein (1 scoop)".

do $$
declare
  uid     uuid;
  n       int;
  meal    uuid;
  food    uuid;
  wanted  constant text[]    := array['steel cut oats', 'ground flaxseed', 'assorted fruit', 'protein powder'];
  amounts constant numeric[] := array[1, 1, 4, 1];
  found   uuid[] := '{}';
begin
  select count(*) into n from auth.users;
  if n <> 1 then
    raise notice 'Usual breakfast not created: expected exactly one account, found %.', n;
    return;
  end if;
  select id into uid from auth.users;

  if exists (select 1 from public.meals where owner_id = uid and name = 'Usual breakfast') then
    raise notice 'Usual breakfast already exists; left as it is.';
    return;
  end if;

  -- All four or nothing: a breakfast quietly missing its oats would log
  -- 150 kcal short every morning and look complete.
  for i in 1 .. array_length(wanted, 1) loop
    select id into food from public.foods
      where owner_id = uid and lower(btrim(name)) = wanted[i] and not archived
      order by created_at
      limit 1;
    if food is null then
      raise notice 'Usual breakfast not created: no food named "%" in the library.', wanted[i];
      return;
    end if;
    found := found || food;
  end loop;

  insert into public.meals (owner_id, name) values (uid, 'Usual breakfast')
    returning id into meal;

  insert into public.meal_items (owner_id, meal_id, food_id, multiplier, position)
  select uid, meal, found[i], amounts[i], i
  from generate_subscripts(found, 1) as i;

  raise notice 'Created Usual breakfast with % foods.', array_length(found, 1);
end;
$$;
