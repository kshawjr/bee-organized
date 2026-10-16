-- migrations/tag_merge_2_one_list_undo.sql
--
-- Undoes migrations/tag_merge_2_one_list.sql: every row that carries
-- attrs.merged_from goes back to its old category and old sort_order, and
-- the two markers come off attrs. The dead-column comments are cleared.
--
-- A tag that corporate CREATED after the merge has no merged_from — it
-- stays in 'tags', which the pre-merge code never reads. The receipt below
-- counts them so nobody is surprised.

WITH back AS (
  UPDATE lookups
     SET category   = attrs->>'merged_from',
         sort_order = (attrs->>'merged_sort_order')::int,
         attrs      = attrs - 'merged_from' - 'merged_sort_order',
         updated_at = now()
   WHERE category = 'tags'
     AND attrs ? 'merged_from'
  RETURNING category
)
SELECT category, count(*) AS rows_restored FROM back GROUP BY category ORDER BY category;

SELECT count(*) AS tags_created_after_merge_left_in_tags
  FROM lookups WHERE category = 'tags';

COMMENT ON COLUMN leads.tags IS NULL;
COMMENT ON COLUMN partners.tags IS NULL;
COMMENT ON COLUMN partners.specialties IS NULL;
