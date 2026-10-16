-- migrations/tag_delete_undo.sql
--
-- Removes the delete machinery (migrations/tag_delete.sql). The functions
-- go; tag_deletions is kept if it holds any record — it is the only trace of
-- what was deleted (and what tag_delete_real_estate_undo.sql re-inserts from).

DROP FUNCTION IF EXISTS delete_tag_if_unused(uuid, uuid);
DROP FUNCTION IF EXISTS tag_delete_blockers(uuid);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tag_deletions) THEN
    RAISE NOTICE 'tag_deletions holds records — kept';
  ELSE
    DROP TABLE IF EXISTS tag_deletions;
  END IF;
END $$;
