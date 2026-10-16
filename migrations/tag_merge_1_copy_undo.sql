-- migrations/tag_merge_1_copy_undo.sql
--
-- Undoes migrations/tag_merge_1_copy.sql: removes exactly the partner_tags
-- links that file made (the ones listed in tag_merge_log) and empties the
-- log. Links people added by hand are untouched. partners.specialties was
-- never changed, so nothing needs restoring there.
--
-- Only run this together with putting the pre-merge code back: the merged
-- code reads Network tags from partner_tags alone, so after this undo it
-- would show those 86 people with no tags.

WITH gone AS (
  DELETE FROM partner_tags pt
  USING tag_merge_log m
  WHERE pt.partner_id = m.partner_id
    AND pt.tag_lookup_id = m.tag_lookup_id
  RETURNING pt.partner_id
)
SELECT count(*) AS links_removed FROM gone;

TRUNCATE tag_merge_log;
