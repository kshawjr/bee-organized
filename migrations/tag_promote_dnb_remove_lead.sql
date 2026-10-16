-- migrations/tag_promote_dnb_remove_lead.sql
--
-- Two decisions (Kevin, 2026-10-16). Needs migrations/tag_make_corporate.sql.
--
-- 1. DO NOT BOOK becomes a corporate tag.
--    Southeast Nashville made it on 25 Aug 2026; one client carries it
--    (Jessica Fudge). Every location needs a way to flag a client never to
--    book again and no other location has one. Corporate, in Relationship (its
--    stored section), in its current place (sort 1080, after No Show), icon
--    🛑 (🚫 is already No Show). Done with make_tag_corporate(): a new
--    corporate DO NOT BOOK, Jessica Fudge linked to it, Southeast Nashville's
--    copy switched off with its link kept — all logged.
--
-- 2. Portland's Lead tag is removed.
--    One client carries it (Judith Schor, at Estimate Sent, tagged ~18 months
--    after she came in) — never a new-lead marker; Bee Hub knows who's a lead
--    from their stage. Removed the way Settings › Tags removes: switched off,
--    her link kept, restorable. Nothing deleted.
--
-- GUARDED: each step names its row by id AND label AND location, and does
-- nothing if any of them has changed since the dry run.
--
-- HOW TO UNDO: migrations/tag_promote_dnb_remove_lead_undo.sql

-- ── 1. DO NOT BOOK → corporate ──
SELECT make_tag_corporate(
  ARRAY['0445337f-b21a-4248-b625-c1185c54b39b']::uuid[],
  'DO NOT BOOK', '🛑', 'relationship',
  NULL, 1080, NULL,
  'tag_promote_dnb_remove_lead: DO NOT BOOK from Southeast Nashville (Kevin, 2026-10-16)'
)
WHERE EXISTS (
  SELECT 1 FROM lookups l JOIN locations loc ON loc.id = l.location_id
   WHERE l.id = '0445337f-b21a-4248-b625-c1185c54b39b' AND l.label = 'DO NOT BOOK'
     AND l.is_active AND loc.name = 'Southeast Nashville'
)
AND NOT EXISTS (
  SELECT 1 FROM lookups WHERE category = 'tags' AND location_id IS NULL AND lower(label) = 'do not book'
);

-- ── 2. Portland's Lead → switched off ──
UPDATE lookups l SET is_active = false, updated_at = now()
  FROM locations loc
 WHERE l.id = 'c02da184-5e25-4690-9e8e-27fd525ff2f5' AND l.label = 'Lead'
   AND loc.id = l.location_id AND loc.name = 'Portland' AND l.is_active;

-- ── receipt — read this before saying it worked ──
-- Expect: corporate_dnb 1 (🛑, relationship, 1080), clients_on_corporate_dnb 1,
-- nashville_copy_active false, nashville_copy_links 1, promotion_links 1,
-- lead_active false, lead_links 1.
SELECT
  (SELECT count(*) FROM lookups WHERE category = 'tags' AND location_id IS NULL AND label = 'DO NOT BOOK' AND is_active) AS corporate_dnb,
  (SELECT icon || ' / ' || (attrs->>'section') || ' / ' || sort_order FROM lookups WHERE category = 'tags' AND location_id IS NULL AND label = 'DO NOT BOOK') AS corporate_dnb_shape,
  (SELECT count(*) FROM lead_tags lt JOIN lookups l ON l.id = lt.tag_lookup_id WHERE l.location_id IS NULL AND l.label = 'DO NOT BOOK') AS clients_on_corporate_dnb,
  (SELECT is_active FROM lookups WHERE id = '0445337f-b21a-4248-b625-c1185c54b39b') AS nashville_copy_active,
  (SELECT count(*) FROM lead_tags WHERE tag_lookup_id = '0445337f-b21a-4248-b625-c1185c54b39b') AS nashville_copy_links,
  (SELECT count(*) FROM tag_promotion_links pl JOIN tag_promotions p ON p.id = pl.promotion_id
    WHERE p.note LIKE 'tag_promote_dnb_remove_lead:%' AND p.undone_at IS NULL) AS promotion_links,
  (SELECT is_active FROM lookups WHERE id = 'c02da184-5e25-4690-9e8e-27fd525ff2f5') AS lead_active,
  (SELECT count(*) FROM lead_tags WHERE tag_lookup_id = 'c02da184-5e25-4690-9e8e-27fd525ff2f5') AS lead_links;
