-- migrations/tag_delete_real_estate.sql
--
-- Deletes North Jersey's "real estate" tag (Kevin, 2026-10-16): his own test
-- tag — the case that showed name-only near-matching missed Realtor's code
-- (real-estate). Switched off, nobody carries it, no undo log names it.
-- Needs migrations/tag_delete.sql. Goes through delete_tag_if_unused(), so it
-- is refused (and nothing happens) if any of that has changed.
--
-- HOW TO UNDO: migrations/tag_delete_real_estate_undo.sql (re-inserts the
-- row, same id, from its tag_deletions record).

SELECT l.id, l.label, loc.name AS location,
       delete_tag_if_unused(l.id, NULL) AS blockers   -- '{}' = deleted
  FROM lookups l JOIN locations loc ON loc.id = l.location_id
 WHERE l.category = 'tags' AND l.label = 'real estate'
   AND loc.name = 'North Jersey' AND NOT l.is_active;

-- receipt: expect real_estate_left 0, deletion_records 1
SELECT
  (SELECT count(*) FROM lookups l JOIN locations loc ON loc.id = l.location_id
    WHERE l.category = 'tags' AND l.label = 'real estate' AND loc.name = 'North Jersey') AS real_estate_left,
  (SELECT count(*) FROM tag_deletions WHERE label = 'real estate') AS deletion_records;
