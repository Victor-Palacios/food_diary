-- Food library import, generated from the Food_Data sheet of Food_Journal.xlsx.
--
-- Run AFTER 0001_init.sql and 0002_optional_fiber.sql, in the Supabase SQL
-- editor. Nothing to edit: it finds the single account itself, and it skips
-- any food whose name is already in the library, so running it twice is safe.
--
-- Mapping from the sheet:
--   Food            -> name; a capitalised ": " prefix becomes the brand
--                      (a lowercase one is part of the dish name, not a vendor)
--   Weight (g)      -> serving_grams and serving_label; 0 meant "not
--                      measured" in the sheet, so it becomes NULL / "1 serving"
--   Saturated Fat   -> fat_sat_g
--   trans fat       -> 0; the sheet has no column for it
--   fiber           -> NULL, i.e. not recorded. The sheet has no fiber column,
--                      and NULL keeps it out of the averages instead of
--                      dragging them down as a zero would.
--   source          -> 'manual' for every row: these were compiled by hand in
--                      a spreadsheet. Change individual rows in the app if a
--                      finer provenance matters.

do $$
declare
  uid uuid;
  n   int;
  inserted int := 0;
begin
  select count(*) into n from auth.users;
  if n = 0 then
    raise exception 'No account exists yet. Create one first, then re-run this file.';
  end if;
  if n > 1 then
    raise exception 'Found % accounts, expected exactly one.', n;
  end if;
  select id into uid from auth.users;

  with incoming (name, brand, serving_label, serving_grams,
                 calories, protein_g, carbs_g, fat_total_g, fat_sat_g, fat_trans_g, fiber_g) as (
    values
  ('Angry Fries', 'Angry Chickz', '687 g', 687, 1410, 54, 112, 83, 14, 0, null),
  ('Angry Mac', 'Angry Chickz', '780 g', 780, 1800, 77, 134, 106, 33, 0, null),
  ('Chicken Slider', 'Angry Chickz', '235 g', 235, 490, 23, 45, 24, 4.5, 0, null),
  ('Chicken Tender Side (Favorite)', 'Angry Chickz', '137 g', 137, 290, 21, 27, 11, 2, 0, null),
  ('Chicken Tenders', 'Angry Chickz', '113 g', 113, 250, 23, 10, 13, 2.5, 0, null),
  ('Classic #1', 'Angry Chickz', '654 g', 654, 1520, 53, 159, 74, 13, 0, null),
  ('Classic #2', 'Angry Chickz', '411 g', 411, 1030, 52, 89, 52, 10, 0, null),
  ('Classic #3', 'Angry Chickz', '532 g', 532, 1280, 53, 124, 63, 11, 0, null),
  ('Classic #4', 'Angry Chickz', '935 g', 935, 1980, 57, 143, 131, 62, 0, null),
  ('Fries', 'Angry Chickz', '198 g', 198, 570, 7, 74, 28, 5, 0, null),
  ('Hangry Fix Bowl', 'Angry Chickz', '809 g', 809, 1810, 62, 123, 119, 55, 0, null),
  ('Mac''n Cheese', 'Angry Chickz', '198 g', 198, 350, 15, 25, 21, 12, 0, null),
  ('Rice', 'Angry Chickz', '170 g', 170, 450, 3, 38, 32, 20, 0, null),
  ('Slaw', 'Angry Chickz', '184 g', 184, 220, 1, 17, 15, 2.5, 0, null),
  ('Special Secret Sauce', 'Angry Chickz', '28 g', 28, 140, 0, 5, 13, 2, 0, null),
  ('apple', null, '180 g', 180, 95, 0, 25, 0, 0, 0, null),
  ('assorted fruit', null, '70 g', 70, 40, 0.5, 10, 0, 0, 0, null),
  ('Chai Latte Protein Shake', 'Atkins', '325 g', 325, 160, 15, 6, 9, 1.5, 0, null),
  ('banana', null, '90 g', 90, 105, 1, 27, 0, 0, 0, null),
  ('Protein Bar Caramel Cashew', 'Barebells', '55 g', 55, 200, 20, 18, 8, 3.5, 0, null),
  ('Protein Bar Hazelnut & Nougat', 'Barebells', '55 g', 55, 220, 15, 27, 10, 4, 0, null),
  ('baumkuchen: pumpkin', null, '93 g', 93, 378, 6.1, 41.8, 6.1, 0, 0, null),
  ('blueberry crumble', null, '70 g', 70, 140, 5, 22, 7, 0.5, 0, null),
  ('bubble gum ice cream tablespoon', null, '20 g', 20, 40, 0.5, 4, 2, 1, 0, null),
  ('cooked white rice', null, '100 g', 100, 130, 3, 28, 0, 0, 0, null),
  ('creatine', null, '5 g', 5, 0, 0, 0, 0, 0, 0, null),
  ('curry (Vermont brand)', null, '20 g', 20, 110, 2, 11, 7, 4, 0, null),
  ('Beef Vermicelli', 'Divis Pho', '580 g', 580, 900, 52, 82, 34, 12, 0, null),
  ('edamame', null, '1 serving', null, 190, 18, 15, 8, 1.5, 0, null),
  ('egg', null, '50 g', 50, 70, 6, 1, 5, 1.6, 0, null),
  ('ground flaxseed', null, '17 g', 17, 100, 4, 5, 7, 0.5, 0, null),
  ('American Wagyu Ground Beef', 'Hamburger (homemade)', '180 g', 180, 510, 23, 31, 31, 12.5, 0, null),
  ('Double-Double', 'In-N-Out', '286 g', 286, 610, 34, 42, 34, 15, 0, null),
  ('Double-Single', 'In-N-Out', '280 g', 280, 540, 30, 42, 28, 11, 0, null),
  ('Chocolate Crunch Cereal (20g of fiber)', 'Kashi Go', '54 g', 54, 210, 10, 34, 7, 1.5, 0, 20),
  ('Orange Cranberry Pumpkin Seed', 'Kind', '40 g', 40, 180, 5, 19, 11, 1.5, 0, null),
  ('kiwi', null, '156 g', 156, 95, 1.8, 22.9, 0.8, 0.1, 0, null),
  ('3x3 Bean Chili Bowl', 'Locale', '700 g', 700, 711, 46, 44, 39, 0, 0, null),
  ('French Onion Grass-Fed Chuck Roast', 'Locale', '700 g', 700, 837, 43, 74, 41, 0, 0, null),
  ('Golden Lentil and Barley Soup', 'Locale', '700 g', 700, 636, 54, 69, 16, 0, 0, null),
  ('Grass Fed Steak and Veggies Plate', 'Locale', '700 g', 700, 708, 45, 42, 40, 13, 0, null),
  ('Grass Fed Steak Plate', 'Locale', '700 g', 700, 801, 44, 55, 45, 0, 0, null),
  ('Grass-Fed Chuck Roast', 'Locale', '700 g', 700, 742, 45, 55, 38, 0, 0, null),
  ('Grass-Fed Ground Beef Bulgogi Bowl', 'Locale', '700 g', 700, 841, 45, 64, 45, 0, 0, null),
  ('Grass-fed Pot Roast Soup', 'Locale', '500 g', 500, 621, 45, 45, 29, 0, 0, null),
  ('Harvest Organic Chicken Bowl', 'Locale', '700 g', 700, 726, 46, 59, 34, 0, 0, null),
  ('Heirloom Carnitas Bowl', 'Locale', '700 g', 700, 842, 40, 76, 42, 0, 0, null),
  ('Hot Honey Organic Chicken Plate', 'Locale', '700 g', 700, 835, 46, 84, 35, 0, 0, null),
  ('Mediterranean Pesto Pasta Salad', 'Locale', '700 g', 700, 754, 52, 42, 42, 0, 0, null),
  ('Melon & Prosciutto Italian Salad', 'Locale', '350 g', 350, 645, 48, 48, 29, 8, 0, null),
  ('Organic Butter Chicken', 'Locale', '700 g', 700, 803, 47, 66, 39, 0, 0, null),
  ('Organic Chicken and Green Tea Piccata', 'Locale', '700 g', 700, 779, 47, 78, 31, 0, 0, null),
  ('Organic Chicken Pesto Bowl', 'Locale', '700 g', 700, 763, 47, 65, 35, 0, 0, null),
  ('Organic Chicken Shawarma', 'Locale', '700 g', 700, 758, 51, 80, 26, 0, 0, null),
  ('Organic Kale, White Bean, and Fig Salad', 'Locale', '400 g', 400, 599, 30, 41, 35, 5, 0, null),
  ('Organic Saag Paneer', 'Locale', '450 g', 450, 808, 31, 81, 40, 16, 0, null),
  ('Organic Turkish Chicken Bowl', 'Locale', '400 g', 400, 792, 45, 72, 36, 9, 0, null),
  ('Pastured Turkey and Lentil Meatloaf', 'Locale', '700 g', 700, 801, 42, 75, 37, 0, 0, null),
  ('Peruvian Grass-Fed Steak Lomo Saltado', 'Locale', '600 g', 600, 740, 45, 59, 36, 0, 0, null),
  ('Puerto Rican Grass Fed Bedd Shepards Pie', 'Locale', '700 g', 700, 764, 45, 65, 36, 0, 0, null),
  ('Rhubarb Chicken', 'Locale', '400 g', 400, 696, 55, 65, 24, 5, 0, null),
  ('Superfood Organic Chicken Caesar Salad', 'Locale', '375 g', 375, 638, 54, 29, 34, 6.5, 0, null),
  ('Surf and Turf Longevity Bowl', 'Locale', '700 g', 700, 808, 50, 53, 44, 0, 0, null),
  ('Thai Coconut Chicken Curry', 'Locale', '500 g', 500, 839, 56, 75, 35, 0, 0, null),
  ('Triple Beet Grass Fed Steak Salad', 'Locale', '700 g', 700, 659, 41, 45, 35, 0, 0, null),
  ('mashed potatoes', null, '150 g', 150, 170, 3, 25, 6, 3, 0, null),
  ('1/2 The Farm Club Sandwich with salad', 'Mendocino Farms', '305 g', 305, 500, 22, 40, 28, 6, 0, null),
  ('Tuscan Pesto Salad', 'Mendocino', '454 g', 454, 780, 34, 47, 50, 9, 0, null),
  ('mikan', null, '100 g', 100, 53, 1, 13, 0, 0, 0, null),
  ('Mixt - Elote', null, '1 serving', null, 640, 51, 36, 36, 8, 0, null),
  ('Mocha Magic', null, '400 g', 400, 290, 27, 32, 6, 2, 0, null),
  ('Asian Sesame Ginger Salad', 'MuscleMakerGrill', '1 serving', null, 480, 32, 41, 23, 3, 0, null),
  ('Avocado Smash', 'MuscleMakerGrill', '1 serving', null, 110, 1, 6, 10, 1, 0, null),
  ('BBQ Wrap', 'MuscleMakerGrill', '1 serving', null, 750, 68, 69, 21, 8, 0, null),
  ('Brown Rice', 'MuscleMakerGrill', '1 serving', null, 180, 4, 39, 1, 0, 0, null),
  ('Brown Rice and Beans', 'MuscleMakerGrill', '1 serving', null, 170, 6, 34, 1, 0, 0, null),
  ('Buffalo ''Shrooms', 'MuscleMakerGrill', '1 serving', null, 340, 10, 46, 14, 2, 0, null),
  ('Caesar Salad', 'MuscleMakerGrill', '1 serving', null, 80, 2, 4, 10, 1.5, 0, null),
  ('Cauliflower Rice', 'MuscleMakerGrill', '1 serving', null, 130, 8, 12, 8, 3, 0, null),
  ('Cucumber Salad', 'MuscleMakerGrill', '1 serving', null, 25, 2, 4, 0, 0, 0, null),
  ('El Mexicana', 'MuscleMakerGrill', '1 serving', null, 490, 51, 49, 11, 3.5, 0, null),
  ('Godfather', 'MuscleMakerGrill', '1 serving', null, 440, 60, 24, 8, 5, 0, null),
  ('Grass-fed Steak', 'MuscleMakerGrill', '180 g', 180, 360, 48, 0, 22, 9, 0, null),
  ('Grilled Chicken', 'MuscleMakerGrill', '1 serving', null, 210, 39, 0, 6, 2, 0, null),
  ('Hardboiled Eggs', 'MuscleMakerGrill', '1 serving', null, 211, 17, 2, 14, 4, 0, null),
  ('Hollywood Salad (GF)', 'MuscleMakerGrill', '1 serving', null, 250, 32, 13, 9, 0, 0, null),
  ('Impossible Chili Bowl', 'MuscleMakerGrill', '1 serving', null, 360, 28, 16, 21, 12, 0, null),
  ('Italiano Salad', 'MuscleMakerGrill', '1 serving', null, 430, 53, 22, 7, 6, 0, null),
  ('Keto Hollywood Salad (Chicken)', 'MuscleMakerGrill', '1 serving', null, 510, 40, 12, 24, 7, 0, null),
  ('Keto Hollywood Salad (Steak)', 'MuscleMakerGrill', '1 serving', null, 540, 38, 12, 28, 9, 0, null),
  ('MMG Caesar Salad', 'MuscleMakerGrill', '1 serving', null, 350, 32, 8, 23, 7, 0, null),
  ('MMG Signature Wrap', 'MuscleMakerGrill', '1 serving', null, 710, 55, 67, 21, 7, 0, null),
  ('Oven Roasted Sweet Potatoes', 'MuscleMakerGrill', '1 serving', null, 610, 2, 25, 56, 8, 0, null),
  ('Philly Caesar Salad (Chicken)', 'MuscleMakerGrill', '1 serving', null, 380, 37, 12, 20, 7, 0, null),
  ('Philly Caesar Salad (Steak)', 'MuscleMakerGrill', '1 serving', null, 410, 35, 12, 24, 9, 0, null),
  ('Roasted Broccoli', 'MuscleMakerGrill', '1 serving', null, 180, 4, 9, 16, 2, 0, null),
  ('Rocky Wrap', 'MuscleMakerGrill', '1 serving', null, 680, 55, 66, 18, 6, 0, null),
  ('Santa Fe Wrap', 'MuscleMakerGrill', '1 serving', null, 700, 49, 77, 22, 8, 0, null),
  ('Sweet Potato Fries', 'MuscleMakerGrill', '1 serving', null, 170, 2, 28, 6, 0, 0, null),
  ('Teriyaki Stir-Fry', 'MuscleMakerGrill', '1 serving', null, 580, 37, 67, 21, 2, 0, null),
  ('Tex-Mex Fajita Wrap', 'MuscleMakerGrill', '1 serving', null, 600, 50, 60, 19, 7, 0, null),
  ('The Buffalo (Chicken)', 'MuscleMakerGrill', '1 serving', null, 590, 40, 17, 43, 10, 0, null),
  ('The Buffalo (Steak)', 'MuscleMakerGrill', '1 serving', null, 630, 38, 17, 47, 11, 0, null),
  ('The Phoenix (Chicken)', 'MuscleMakerGrill', '1 serving', null, 410, 38, 15, 14, 5, 0, null),
  ('The Phoenix (Steak)', 'MuscleMakerGrill', '1 serving', null, 490, 42, 15, 20, 7, 0, null),
  ('Turkey Meatball Wrap', 'MuscleMakerGrill', '1 serving', null, 670, 42, 73, 19, 9, 0, null),
  ('Turkey Meatballs', 'MuscleMakerGrill', '1 serving', null, 300, 31, 23, 14, 3.4, 0, null),
  ('Veggie Wrap', 'MuscleMakerGrill', '1 serving', null, 470, 20, 66, 14, 3.5, 0, null),
  ('paitan ramen', null, '500 g', 500, 780, 40, 84, 29, 11, 0, null),
  ('Beef Enchiladas, rice, and beans', 'Panchitas', '600 g', 600, 980, 36, 105, 46, 19, 0, null),
  ('pandan coffee', null, '450 g', 450, 360, 8, 45, 18, 10, 0, null),
  ('Chicken Pesto Ciabatta Dipper (no cheese)', 'Panera', '400 g', 400, 690, 45, 91, 16, 8, 0, null),
  ('Sink Cookie', 'Panera', '200 g', 200, 810, 7, 100, 42, 26, 0, null),
  ('pear', null, '100 g', 100, 57, 0.4, 15, 0.1, 0, 0, null),
  ('pete''s coffee''s oatmeal', null, '80 g', 80, 355, 8.5, 58, 10.5, 1, 0, null),
  ('pork banh mi', null, '400 g', 400, 620, 35, 75, 30, 9, 0, null),
  ('pork slices (steamed)', null, '100 g', 100, 165, 27, 0, 6, 2, 0, null),
  ('pork tamale', null, '140 g', 140, 250, 9, 18, 18, 4, 0, null),
  ('All-natural Grilled Hanger Steak', 'Proper Food', '96 g', 96, 200, 24, 0, 11, 4.5, 0, null),
  ('Carne Asada Burrito', 'Proper Food', '309 g', 309, 630, 31, 67, 26, 12, 0, null),
  ('Cinnamon Mocha', 'Proper Food', '435 g', 435, 100, 3, 17, 2, 0, 0, null),
  ('Coconut Chia Seed Pudding', 'Proper Food', '219 g', 219, 180, 2, 31, 7, 3, 0, null),
  ('Moroccan Spiced Steak Sandwich', 'Proper Food', '274 g', 274, 640, 34, 67, 29, 7, 0, null),
  ('Swiss Style Muesli', 'Proper Food', '243 g', 243, 350, 6, 73, 8, 1, 0, null),
  ('protein (1 scoop)', null, '33 g', 33, 120, 25, 4, 1, 0, 0, null),
  ('protein (2 scoops)', null, '66 g', 66, 240, 50, 8, 2, 0, 0, null),
  ('protein milk', null, '414 g', 414, 230, 42, 9, 3.5, 2, 0, null),
  ('protein powder', null, '33 g', 33, 120, 25, 4, 1, 0, 0, null),
  ('Pea Protein Milk', 'Ripple', '240 g', 240, 140, 8, 17, 4.5, 0.5, 0, null),
  ('rotisserie chicken', null, '100 g', 100, 200, 23, 0, 11, 3, 0, null),
  ('Sightglass Coffee-Rubbed Grass Fed Hanger Steak', null, '400 g', 400, 793, 50, 56, 41, 13, 0, null),
  ('smoked turkey brisket', null, '400 g', 400, 880, 54, 88, 38, 18, 0, null),
  ('Souvla Lamb Sandwich', null, '330 g', 330, 527, 42, 29, 27, 11, 0, null),
  ('Pork Shoulder Sandwich', 'Souvla', '300 g', 300, 557, 36, 29, 33, 12, 0, null),
  ('steel cut oats', null, '45 g', 45, 180, 8, 30, 3, 0.5, 0, null),
  ('Chicken Pesto Parma', 'Sweet Greens', '431 g', 431, 545, 41, 38, 24, 4, 0, null),
  ('Chia Seeds (1 tbsp)', 'Trader Joes', '12 g', 12, 60, 2.5, 4, 4, 0.5, 0, null),
  ('Chicken & Cheddar Cheese Sandwich', 'Trader Joes', '241 g', 241, 550, 34, 55, 22, 6, 0, null),
  ('Protein Pancakes', 'Trader Joes', '139 g', 139, 220, 20, 25, 4.5, 1.5, 0, null),
  ('Roasted Turkey & Sweet Potato', 'Trader Joes', '227 g', 227, 470, 18, 70, 12, 1.5, 0, null),
  ('Turkey Apple Cheddar Sandwich', 'Trader Joes', '242 g', 242, 490, 23, 45, 24, 5, 0, null),
  ('Brown butter Chocolate Cookie', 'WholeFoods', '57 g', 57, 390, 5, 50, 19, 11, 0, null),
  ('Chewy Protein Bites - Cinnamon and Apple', 'WholeFoods', '45 g', 45, 160, 7, 28, 3, 0, 0, null),
  ('Chewy Protein Bites - Coconut and Macadamia', 'WholeFoods', '45 g', 45, 240, 10, 21, 8, 2, 0, null),
  ('Chewy Protein Bites - Coffee & Almond', 'WholeFoods', '45 g', 45, 180, 8, 23, 7, 0.5, 0, null),
  ('Chewy Protein Bites - PB&J', 'WholeFoods', '45 g', 45, 180, 10, 21, 6, 1, 0, null),
  ('Chewy Protein Bites - Vanilla and Almonds', 'WholeFoods', '45 g', 45, 200, 10, 23, 8, 1, 0, null),
  ('Chocolate Oatmeal Cookie', 'WholeFoods', '57 g', 57, 350, 3, 47, 17, 4.5, 0, null),
  ('Omega-3 Trail Mix', 'WholeFoods', '30 g', 30, 160, 4, 10, 13, 1.5, 0, null),
  ('yakult', null, '80 g', 80, 50, 1, 12, 0, 0, 0, null)
  ),
  new_rows as (
    insert into public.foods
      (owner_id, name, brand, serving_label, serving_grams,
       calories, protein_g, carbs_g, fat_total_g, fat_sat_g, fat_trans_g, fiber_g,
       source, is_estimate)
    select
      uid, i.name, i.brand, i.serving_label, i.serving_grams,
      i.calories, i.protein_g, i.carbs_g, i.fat_total_g, i.fat_sat_g, i.fat_trans_g, i.fiber_g,
      'manual', false
    from incoming i
    where not exists (
      select 1 from public.foods f
      where f.owner_id = uid and lower(f.name) = lower(i.name)
    )
    returning 1
  )
  select count(*) into inserted from new_rows;

  raise notice 'Imported % foods (skipped any already in the library).', inserted;
end;
$$;
