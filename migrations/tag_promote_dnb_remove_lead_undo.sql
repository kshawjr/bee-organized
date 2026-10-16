-- migrations/tag_promote_dnb_remove_lead_undo.sql
--
-- Undoes migrations/tag_promote_dnb_remove_lead.sql exactly:
--   1. the DO NOT BOOK promotion, through undo_tag_promotion(): the link it
--      added goes, Southeast Nashville's copy is switched back on, and the
--      corporate DO NOT BOOK is removed (or switched off if someone has been
--      given it by hand since)
--   2. Portland's Lead switched back on (its link never moved)

SELECT undo_tag_promotion(id)
  FROM tag_promotions
 WHERE note LIKE 'tag_promote_dnb_remove_lead:%' AND undone_at IS NULL;

UPDATE lookups SET is_active = true, updated_at = now()
 WHERE id = 'c02da184-5e25-4690-9e8e-27fd525ff2f5' AND label = 'Lead' AND NOT is_active;

SELECT
  (SELECT is_active FROM lookups WHERE id = '0445337f-b21a-4248-b625-c1185c54b39b') AS nashville_copy_active,
  (SELECT count(*) FROM lookups WHERE category = 'tags' AND location_id IS NULL AND label = 'DO NOT BOOK') AS corporate_dnb_left,
  (SELECT is_active FROM lookups WHERE id = 'c02da184-5e25-4690-9e8e-27fd525ff2f5') AS lead_active;
