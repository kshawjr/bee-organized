-- migrations/tag_sections_undo.sql
--
-- Undoes migrations/tag_sections.sql: removes attrs.section from exactly the
-- tags that file wrote and nobody has touched since (attrs.section_set_by =
-- 'tag_sections'). Saving a tag on the Configure tab drops that marker, so a
-- section a person chose — on a new tag or by re-saving a migrated one — is
-- kept. A tag with no section shows under Trade on screen.

WITH cleared AS (
  UPDATE lookups
     SET attrs = attrs - 'section' - 'section_set_by',
         updated_at = now()
   WHERE category = 'tags'
     AND attrs->>'section_set_by' = 'tag_sections'
  RETURNING id
)
SELECT count(*) AS tags_cleared FROM cleared;
