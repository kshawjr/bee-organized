-- migrations/phone_normalized_drop_leading_one.sql
--
-- PURPOSE
--   leads.phone_normalized becomes the SAME matching key as phoneKey() in
--   lib/phone.ts: the number's digits with a leading US "1" on an 11-digit
--   number dropped, then the extension's digits.
--
-- WHAT IS WRONG TODAY
--   The column is NULLIF(regexp_replace(phone, '[^0-9]', '', 'g'), '') —
--   every digit, kept. So "+1 (646) 708-2407" is 16467082407 and
--   "646.708.2407" is 6467082407, and the duplicate check (which compares
--   this column) calls them two different people. Measured 16 Oct 2026, on
--   leads with archived_at null, same location_uuid, 10-digit vs
--   "1"+same-10-digit: 18 pairings over 17 eleven-digit records. 7 of the
--   18 also share an email, so the check caught those anyway; 11 slipped
--   through.
--   Extensions keep their digits on the end on purpose — "609 978-4046" and
--   "609 978-4046 x1216" are two people at one office line — but the leading
--   1 is now dropped before them, so "1-888-837-3363 ext 70" and
--   "(888) 837-3363 ext. 70" key the same.
--
-- SAFE TO RUN BEFORE OR AFTER THE CODE SHIPS
--   buildLeadMatchOr queries phone_normalized IN (key, '1'||key) while rows
--   from before this migration may still hold the 1. Once this has run that
--   second value simply matches nothing.
--
-- COST
--   Postgres 17 SET EXPRESSION rewrites leads (~45k rows) and rebuilds
--   leads_phone_normalized_idx under an exclusive lock: about a second.
--   leads_full (a view on leads) is unaffected — tested on a temp table +
--   view, rolled back, 16 Oct 2026.
--
-- KEEP IN STEP
--   EXT_TAIL_RE and phoneKey in lib/phone.ts are the JS twin of this
--   expression. scripts/backfill-phone-format.mjs dry run compares the two on
--   every stored phone and reports any row where they disagree.

ALTER TABLE public.leads
  ALTER COLUMN phone_normalized SET EXPRESSION AS (
    nullif(
      CASE
        WHEN regexp_replace(regexp_replace(phone, '\m(extension|ext|x)\.?\s*[:=.]?\s*\d+.*$', '', 'i'), '\D', '', 'g') ~ '^1\d{10}$'
          THEN substr(regexp_replace(regexp_replace(phone, '\m(extension|ext|x)\.?\s*[:=.]?\s*\d+.*$', '', 'i'), '\D', '', 'g'), 2)
        ELSE regexp_replace(regexp_replace(phone, '\m(extension|ext|x)\.?\s*[:=.]?\s*\d+.*$', '', 'i'), '\D', '', 'g')
      END
      || coalesce((regexp_match(phone, '\m(?:extension|ext|x)\.?\s*[:=.]?\s*(\d+)', 'i'))[1], ''),
    '')
  );

-- Check (expect 0):
--   select count(*) from leads where length(phone_normalized) = 11 and phone_normalized like '1%';
