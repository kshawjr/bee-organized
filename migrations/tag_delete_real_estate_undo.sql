-- migrations/tag_delete_real_estate_undo.sql
--
-- Puts North Jersey's "real estate" tag back exactly — same id, same row —
-- from its tag_deletions record, and drops that record.

WITH rec AS (
  SELECT id, tag_row FROM tag_deletions WHERE label = 'real estate' ORDER BY deleted_at DESC LIMIT 1
), back AS (
  INSERT INTO lookups SELECT (jsonb_populate_record(NULL::lookups, tag_row)).* FROM rec
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
DELETE FROM tag_deletions WHERE id IN (SELECT id FROM rec) AND EXISTS (SELECT 1 FROM back);

SELECT count(*) AS real_estate_back FROM lookups WHERE category = 'tags' AND label = 'real estate';
