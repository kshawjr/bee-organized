-- migrations/tag_delete.sql
--
-- PURPOSE
--   Permanent delete for a tag NOBODY needs (Kevin, 2026-10-16). Offered for:
--     · a location's own tag (switched on or off)
--     · a corporate tag that is switched off AND was never part of the merge
--       (no attrs.merged_from). The retired corporate tags FROM the merge are
--       never deleted here: they are what tells an owner "corporate retired
--       Housekeeper" and files the request to bring it back.
--   Blocked — with the reason, never silently — when ANY of these holds:
--     clients:N / network:N   people carry it
--     tag_merge_log           the tag-merge undo needs it
--     relationship_tag_log    the relationship → tags undo needs it
--     promotion               a Make-corporate log names it (even one undone)
--     corporate_active        a live corporate tag — switch it off first
--     corporate_merged        a retired tag from the merge — kept on purpose
--   A HARD delete: no switch-off, no undo button. Before the row goes, it is
--   copied whole into tag_deletions — an audit trail (what, where, who,
--   when), not a recycle bin.
--
-- tag_delete_blockers() and delete_tag_if_unused() share ONE definition of
-- "blocked"; the delete checks and deletes under a row lock in one
-- transaction, so nobody can tag a person between the check and the delete
-- (a Network link would otherwise vanish with it — partner_tags cascades).
--
-- THIS FILE CHANGES NO TAG. The first use is
-- migrations/tag_delete_real_estate.sql.
--
-- HOW TO UNDO: migrations/tag_delete_undo.sql

CREATE TABLE IF NOT EXISTS tag_deletions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  deleted_by  uuid,
  tag_id      uuid        NOT NULL,
  label       text        NOT NULL,
  location_id uuid,
  tag_row     jsonb       NOT NULL   -- the whole lookups row as it was
);
ALTER TABLE tag_deletions ENABLE ROW LEVEL SECURITY;

-- Why this tag can't be deleted ('{}' = it can). Read-only.
CREATE OR REPLACE FUNCTION tag_delete_blockers(p_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  t lookups%ROWTYPE;
  b text[] := '{}';
  n int;
BEGIN
  SELECT * INTO t FROM lookups WHERE id = p_id;
  IF NOT FOUND THEN RETURN ARRAY['not_found']; END IF;
  IF t.category <> 'tags' THEN RETURN ARRAY['not_a_tag']; END IF;
  IF t.location_id IS NULL THEN
    IF t.is_active THEN b := b || 'corporate_active'::text; END IF;
    IF t.attrs ? 'merged_from' THEN b := b || 'corporate_merged'::text; END IF;
  END IF;
  SELECT count(*) INTO n FROM lead_tags WHERE tag_lookup_id = p_id;
  IF n > 0 THEN b := b || ('clients:' || n); END IF;
  SELECT count(*) INTO n FROM partner_tags WHERE tag_lookup_id = p_id;
  IF n > 0 THEN b := b || ('network:' || n); END IF;
  IF to_regclass('public.tag_merge_log') IS NOT NULL
     AND EXISTS (SELECT 1 FROM tag_merge_log WHERE tag_lookup_id = p_id) THEN b := b || 'tag_merge_log'::text; END IF;
  IF to_regclass('public.relationship_tag_log') IS NOT NULL
     AND EXISTS (SELECT 1 FROM relationship_tag_log WHERE tag_lookup_id = p_id) THEN b := b || 'relationship_tag_log'::text; END IF;
  IF to_regclass('public.tag_promotions') IS NOT NULL AND (
       EXISTS (SELECT 1 FROM tag_promotions WHERE corporate_tag_id = p_id)
    OR EXISTS (SELECT 1 FROM tag_promotion_copies WHERE tag_id = p_id)
    OR EXISTS (SELECT 1 FROM tag_promotion_links WHERE from_tag_id = p_id OR to_tag_id = p_id)
  ) THEN b := b || 'promotion'::text; END IF;
  RETURN b;
END $$;

-- Delete it if nothing blocks it. Returns '{}' when deleted, else the
-- blockers (and deletes nothing).
CREATE OR REPLACE FUNCTION delete_tag_if_unused(p_id uuid, p_by uuid DEFAULT NULL) RETURNS text[]
LANGUAGE plpgsql AS $$
DECLARE
  t lookups%ROWTYPE;
  b text[];
BEGIN
  SELECT * INTO t FROM lookups WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN ARRAY['not_found']; END IF;
  -- Hold the links still while deciding: no one tags anybody meanwhile.
  LOCK TABLE lead_tags, partner_tags IN SHARE ROW EXCLUSIVE MODE;
  b := tag_delete_blockers(p_id);
  IF cardinality(b) > 0 THEN RETURN b; END IF;
  INSERT INTO tag_deletions (deleted_by, tag_id, label, location_id, tag_row)
  VALUES (p_by, t.id, t.label, t.location_id, to_jsonb(t));
  DELETE FROM lookups WHERE id = p_id;
  RETURN '{}';
END $$;
