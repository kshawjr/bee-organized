-- migrations/tag_sections.sql
--
-- PURPOSE
--   Every tag picker splits the one tag list into two sections (Kevin,
--   2026-10-15; lib/tags.ts):
--     relationship — what the person is to you
--     trade        — what they do
--   This writes lookups.attrs.section on the existing tags, derived from
--   WHERE EACH TAG CAME FROM — never from its name:
--     merged_from client_tags / partner_tags   → relationship
--     created_by relationship_to_tags          → relationship
--     merged_from partner_specialties          → trade
--   A tag that matches none of these is left alone; the app shows a tag
--   with no section under Trade (it never vanishes).
--
-- MEASURED ON PRODUCTION 2026-10-15 (before running)
--   47 tags. Switched on: 9 relationship (Hot Lead, VIP, Referral, No Show,
--   DO NOT BOOK, Lead, Partner, Vendor, Friend) + 21 trade. Switched off:
--   3 relationship + 14 trade. No tag carries a section yet.
--   attrs.group (the old seven groups) is left untouched — nothing reads it.
--
-- SAFE TO RE-RUN
--   Only tags with no section are written, so a section corporate set (or
--   changed) on the Configure tab is never overwritten.
--
-- HOW TO UNDO
--   migrations/tag_sections_undo.sql — removes the section from exactly
--   the tags this file wrote (attrs.section_set_by).

WITH written AS (
  UPDATE lookups
     SET attrs = attrs || jsonb_build_object(
           'section', CASE
                        WHEN attrs->>'merged_from' IN ('client_tags', 'partner_tags') THEN 'relationship'
                        WHEN attrs->>'created_by' = 'relationship_to_tags'            THEN 'relationship'
                        ELSE 'trade'   -- merged_from = 'partner_specialties' (WHERE below)
                      END,
           'section_set_by', 'tag_sections'),
         updated_at = now()
   WHERE category = 'tags'
     AND NOT (attrs ? 'section')
     AND (attrs->>'merged_from' IN ('client_tags', 'partner_tags', 'partner_specialties')
          OR attrs->>'created_by' = 'relationship_to_tags')
  RETURNING attrs->>'section' AS section, is_active
)
SELECT section, is_active, count(*) AS tags_written
FROM written GROUP BY section, is_active ORDER BY section, is_active DESC;
-- Expect: relationship/on 9, relationship/off 3, trade/on 21, trade/off 14.
