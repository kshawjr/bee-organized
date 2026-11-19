-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/network_names_backfill.sql — Network slice 5, third follow-up
-- STEP 2 OF 2: fill first and last name on the contacts whose name is
-- exactly two words. Run AFTER network_names_columns.sql.
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN. Kevin runs it (263 rows on 2026-11-19's copy). Safe to run twice: the second run
-- changes 0 rows (it only fills rows whose first and last are both blank).
--
-- READ THE REPORT FIRST. Every contact it fills, and every one it leaves:
--   ~/Projects/bee-organized-repair-reports/2026-11-19/network-names-dry-run.md
--
-- WHAT IT WRITES. partners.first_name and partners.last_name, nothing else.
-- `name`, updated_at and every other column stay exactly as they are.
-- public.partners has no trigger.
--
-- WHICH ROWS. A live contact (not in the recycle bin) whose name, with extra
-- spaces tidied, is exactly two words: first word → first name, second word
-- → last name. Left alone, first and last blank, `name` untouched:
--   · three or more words ("Mary Lou Geoghagen" — code does not guess)
--   · one word
--   · a joint name (& + / or " and ")
--   · anything typed Organization
--   · eight held by id. Seven businesses typed as a person: Advanced Moving and
--     Concept Cleaning (Kevin's ruling 2026-11-19), and Honor Floral,
--     Infinity Impressions, Imagine Housing, Graceful Compass and College
--     Hunks (found before the backfill ran, 2026-11-19). And Bee Van (Sioux
--     Falls: no email, phone or website, most likely the branded van; Kevin's
--     ruling 2026-11-19, a blank first name is nothing, a wrong one is sent
--     in an email). Every other name this fills was checked for an email
--     domain matching the name, a role email (info@, hello@…), a website, or
--     a business word; Kevin ruled all 66 it flagged are people, filled.
--
-- ONE STATEMENT, on purpose (the Supabase editor forgets temp tables).
-- UNDO: migrations/network_names_backfill_undo.sql
-- ═══════════════════════════════════════════════════════════════════════════

update public.partners p
set first_name = s.parts[1],
    last_name  = s.parts[2]
from (
  select id, string_to_array(regexp_replace(btrim(name), '\s+', ' ', 'g'), ' ') as parts
  from public.partners
) s
where p.id = s.id
  and p.deleted_at is null
  and p.first_name is null
  and p.last_name is null
  and array_length(s.parts, 1) = 2
  and p.name !~ '[&+/]'
  and p.name !~* '(^|\s)and(\s|$)'
  and not coalesce('organization' = any (p.network_types), false)
  and p.id not in ('956ec9c1-fd6e-497c-97ec-cf7d45347993',  -- Advanced Moving, Sioux Falls
                   'bae2cb47-5b5a-42ad-93c1-4d755099a5b5',  -- Concept Cleaning, West St Louis
                   'b8c284dd-2d40-4f84-8669-1fbe3f2c7dad',  -- Honor Floral, Portland
                   '210f2577-49ac-449c-bd07-8bc36ddecffb',  -- Infinity Impressions, Portland
                   'e4b4f98a-8fe7-4446-8f85-85441eba95e1',  -- Imagine Housing, Seattle
                   '7c294181-26f0-4df4-a846-7637b05312d4',  -- Graceful Compass, Palm Beach
                   'c77409ca-dee0-4083-bafb-94b287b3ecf5',  -- Bee Van, Sioux Falls
                   'cb654cc4-84d1-4ddd-b714-f388d9fb8630'); -- College Hunks, West St Louis
