-- migrations/tag_make_corporate_undo.sql
--
-- Removes the Make-corporate machinery (migrations/tag_make_corporate.sql).
-- Undo every promotion FIRST (undo_tag_promotion, or
-- tag_promote_dnb_remove_lead_undo.sql for the first one): the log tables are
-- only dropped while no promotion is left un-undone, so this can never throw
-- away the record an undo needs.

DROP FUNCTION IF EXISTS make_tag_corporate(uuid[], text, text, text, uuid, int, uuid, text);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tag_promotions WHERE undone_at IS NULL) THEN
    RAISE NOTICE 'tag_promotions has live promotions — log tables and undo_tag_promotion kept';
  ELSE
    DROP FUNCTION IF EXISTS undo_tag_promotion(uuid);
    DROP TABLE IF EXISTS tag_promotion_links;
    DROP TABLE IF EXISTS tag_promotion_copies;
    DROP TABLE IF EXISTS tag_promotions;
  END IF;
END $$;
