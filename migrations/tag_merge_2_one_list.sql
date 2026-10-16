-- migrations/tag_merge_2_one_list.sql
--
-- PURPOSE
--   Tag merge, step 2 of 2: the three tag lists in `lookups` become ONE list,
--   category 'tags', shared by clients and Network people (Kevin's ruling,
--   2026-10-15).
--     client_tags          7 corporate + 2 location-owned rows
--     partner_specialties  35 corporate rows
--     partner_tags         1 corporate row ('Partner')
--   = 45 rows, none switched off, no two sharing a name in the same scope
--   (checked against lookups_scope_label_uniq on production 2026-10-15).
--
-- RUN ONLY AFTER the merged code is live (lib/tags.ts run order, step 4).
-- The OLD code asks for the three old category names and would find
-- nothing once this has run.
--
-- WHAT CHANGES, PER ROW
--   · category → 'tags'
--   · sort_order → re-based so the one list keeps today's grouping:
--       client tags first (1000+), then specialties (2000+), then the
--       Partner tag (3000+), each keeping its own order inside its group
--   · attrs gains merged_from (the old category) and merged_sort_order (the
--     old sort_order) — that is what makes this reversible
--   Ids, labels, slugs (attrs.key), colours, location ownership: unchanged.
--   Every lead_tags and partner_tags link points at an id, so every link
--   keeps working without being touched.
--
-- ALSO
--   Marks the columns that are now dead with a database comment. Nothing is
--   dropped — that is its own decision.
--
-- HOW TO UNDO
--   migrations/tag_merge_2_one_list_undo.sql

-- ── 0. preview (read-only) — run alone first if you want to see it ──
-- SELECT category, count(*), min(sort_order), max(sort_order)
--   FROM lookups WHERE category IN ('client_tags','partner_specialties','partner_tags')
--  GROUP BY category;

-- ── 1. the merge — one statement ──
WITH moved AS (
  UPDATE lookups
     SET attrs = attrs || jsonb_build_object('merged_from', category, 'merged_sort_order', sort_order),
         sort_order = CASE category
                        WHEN 'client_tags'         THEN 1000
                        WHEN 'partner_specialties' THEN 2000
                        ELSE                            3000
                      END + sort_order,
         category = 'tags',
         updated_at = now()
   WHERE category IN ('client_tags', 'partner_specialties', 'partner_tags')
  RETURNING attrs->>'merged_from' AS was
)
SELECT was, count(*) AS rows_moved FROM moved GROUP BY was ORDER BY was;
-- Expect: client_tags 9, partner_specialties 35, partner_tags 1.

-- ── 2. mark the dead (comments only — nothing dropped) ──
COMMENT ON COLUMN leads.tags IS
  'DEAD (tag merge 2026-10-15): empty on every row, read and written by nothing. Client tags live in lead_tags. Candidate to drop — separate decision.';
COMMENT ON COLUMN partners.tags IS
  'DEAD (tag merge 2026-10-15): empty on every row, no longer read or written. Network tags live in partner_tags. Candidate to drop — separate decision.';
COMMENT ON COLUMN partners.specialties IS
  'RETIRED (tag merge 2026-10-15): copied into partner_tags by migrations/tag_merge_1_copy.sql (receipt: tag_merge_log); no longer read or written. Kept as the original copy. Candidate to drop — separate decision.';
