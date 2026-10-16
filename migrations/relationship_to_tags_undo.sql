-- migrations/relationship_to_tags_undo.sql
--
-- Undoes migrations/relationship_to_tags.sql:
--   1. removes exactly the links it made (relationship_tag_log) — tags people
--      already had, or added by hand, are untouched
--   2. removes the Vendor and Friend tags it created — but ONLY if nothing
--      links to them any more. If an owner has since tagged someone Vendor
--      by hand, deleting the tag would wipe that Network link (partner_tags
--      cascades) or fail on a client link (lead_tags restricts), so such a
--      tag is switched OFF instead and the receipt says so
--   3. clears the dead-column comment
-- partners.relationship was never changed, so nothing needs restoring there.

-- ── 1. the copied links ──
DELETE FROM partner_tags pt
USING relationship_tag_log g
WHERE pt.partner_id = g.partner_id
  AND pt.tag_lookup_id = g.tag_lookup_id;

TRUNCATE relationship_tag_log;

-- ── 2. the two created tags: delete if unused, else switch off ──
DELETE FROM lookups l
WHERE l.attrs->>'created_by' = 'relationship_to_tags'
  AND NOT EXISTS (SELECT 1 FROM partner_tags pt WHERE pt.tag_lookup_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.tag_lookup_id = l.id);

UPDATE lookups SET is_active = false, updated_at = now()
WHERE attrs->>'created_by' = 'relationship_to_tags';

-- ── 3. the comment ──
COMMENT ON COLUMN partners.relationship IS NULL;

-- ── receipt: expect both 0 unless someone used the tags by hand ──
SELECT
  (SELECT count(*) FROM lookups WHERE attrs->>'created_by' = 'relationship_to_tags') AS created_tags_left_switched_off,
  (SELECT count(*) FROM relationship_tag_log)                                        AS log_rows;
