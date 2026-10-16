-- migrations/tag_make_corporate.sql
--
-- PURPOSE
--   "Make corporate" (Configure › Location tags, 2026-10-16): collapse one or
--   more locations' own versions of the same tag into ONE corporate tag.
--     1. the corporate tag — created, or an existing corporate tag used as
--        the target (switched back on if it was off)
--     2. every person carrying any of the location copies is linked to the
--        corporate tag — ADDED, never moved: the copy's link is KEPT
--     3. the location copies are switched off (hidden everywhere — a
--        switched-off tag is already hidden on records, pickers, filters)
--     4. all of it logged, so undo_tag_promotion() reverses it exactly:
--        it removes only the links promotion added, puts each copy back to
--        the on/off state it had, and removes the corporate tag only if
--        promotion created it and nobody has used it since
--   Each call is ONE function = one transaction: it all lands or none of it.
--
-- WHY ADD AND KEEP, NOT MOVE
--   Nothing is deleted, so nothing has to be re-created on undo. The person's
--   old link to the (now switched-off) copy is invisible in the app and is
--   exactly where it was if the promotion is undone.
--
-- THIS FILE ONLY CREATES THE MACHINERY. It changes no tag and no link.
-- The first real use is migrations/tag_promote_dnb_remove_lead.sql.
--
-- HOW TO UNDO THIS FILE
--   migrations/tag_make_corporate_undo.sql — drops the functions, and the log
--   tables only while no promotion has been recorded.

-- ── the log ──
CREATE TABLE IF NOT EXISTS tag_promotions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  note                  text,
  corporate_tag_id      uuid        NOT NULL,
  corporate_tag_created boolean     NOT NULL,   -- true: undo may remove it
  target_was_active     boolean,                -- an existing target's prior state
  undone_at             timestamptz
);
CREATE TABLE IF NOT EXISTS tag_promotion_copies (
  promotion_id  uuid    NOT NULL REFERENCES tag_promotions(id),
  tag_id        uuid    NOT NULL,
  was_active    boolean NOT NULL,
  PRIMARY KEY (promotion_id, tag_id)
);
-- Only the links promotion ADDED. A person who already carried the target
-- gets no row — undo must leave their link alone.
CREATE TABLE IF NOT EXISTS tag_promotion_links (
  promotion_id  uuid NOT NULL REFERENCES tag_promotions(id),
  kind          text NOT NULL CHECK (kind IN ('lead', 'partner')),
  record_id     uuid NOT NULL,
  from_tag_id   uuid NOT NULL,
  to_tag_id     uuid NOT NULL,
  PRIMARY KEY (promotion_id, kind, record_id)
);
-- Service-role only, like every other tag table.
ALTER TABLE tag_promotions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_promotion_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_promotion_links  ENABLE ROW LEVEL SECURITY;

-- ── make_tag_corporate ──
-- p_copy_ids   the location tags to collapse (each must be a location-owned tag)
-- p_target_id  an existing CORPORATE tag to collapse into, or NULL to create
--              one from p_label / p_icon / p_section
-- p_sort_order the new tag's place in its section (NULL → after the section's last)
-- Returns the promotion id.
CREATE OR REPLACE FUNCTION make_tag_corporate(
  p_copy_ids   uuid[],
  p_label      text,
  p_icon       text,
  p_section    text,
  p_target_id  uuid    DEFAULT NULL,
  p_sort_order int     DEFAULT NULL,
  p_by         uuid    DEFAULT NULL,
  p_note       text    DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_promo  uuid;
  v_target uuid;
  v_created boolean := false;
  v_was_active boolean;
  v_n int;
BEGIN
  IF p_copy_ids IS NULL OR cardinality(p_copy_ids) = 0 THEN
    RAISE EXCEPTION 'make_tag_corporate: no location tags given';
  END IF;
  SELECT count(*) INTO v_n FROM lookups
   WHERE id = ANY(p_copy_ids) AND category = 'tags' AND location_id IS NOT NULL;
  IF v_n <> cardinality(p_copy_ids) THEN
    RAISE EXCEPTION 'make_tag_corporate: every id must be a location-owned tag (% of % are)', v_n, cardinality(p_copy_ids);
  END IF;

  IF p_target_id IS NOT NULL THEN
    SELECT is_active INTO v_was_active FROM lookups
     WHERE id = p_target_id AND category = 'tags' AND location_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'make_tag_corporate: target is not a corporate tag'; END IF;
    v_target := p_target_id;
    UPDATE lookups SET is_active = true, updated_at = now() WHERE id = v_target AND NOT is_active;
  ELSE
    IF p_section NOT IN ('relationship', 'trade') THEN
      RAISE EXCEPTION 'make_tag_corporate: section must be relationship or trade';
    END IF;
    INSERT INTO lookups (category, label, icon, location_id, is_active, sort_order, attrs)
    VALUES ('tags', trim(p_label), NULLIF(trim(coalesce(p_icon, '')), ''), NULL, true,
            coalesce(p_sort_order,
              (SELECT coalesce(max(sort_order), 0) + 10 FROM lookups
                WHERE category = 'tags' AND location_id IS NULL AND attrs->>'section' = p_section)),
            jsonb_build_object('section', p_section, 'promoted_from', to_jsonb(p_copy_ids)))
    RETURNING id INTO v_target;
    v_created := true;
  END IF;

  INSERT INTO tag_promotions (created_by, note, corporate_tag_id, corporate_tag_created, target_was_active)
  VALUES (p_by, p_note, v_target, v_created, v_was_active)
  RETURNING id INTO v_promo;

  INSERT INTO tag_promotion_copies (promotion_id, tag_id, was_active)
  SELECT v_promo, id, is_active FROM lookups WHERE id = ANY(p_copy_ids);

  -- Clients: add the corporate link; log only what was actually added.
  WITH src AS (
    SELECT DISTINCT ON (lead_id) lead_id, tag_lookup_id AS from_tag
      FROM lead_tags WHERE tag_lookup_id = ANY(p_copy_ids)
     ORDER BY lead_id, tag_lookup_id
  ), ins AS (
    INSERT INTO lead_tags (lead_id, tag_lookup_id)
    SELECT lead_id, v_target FROM src
    ON CONFLICT (lead_id, tag_lookup_id) DO NOTHING
    RETURNING lead_id
  )
  INSERT INTO tag_promotion_links (promotion_id, kind, record_id, from_tag_id, to_tag_id)
  SELECT v_promo, 'lead', s.lead_id, s.from_tag, v_target FROM src s JOIN ins USING (lead_id);

  -- Network people: the same.
  WITH src AS (
    SELECT DISTINCT ON (partner_id) partner_id, tag_lookup_id AS from_tag
      FROM partner_tags WHERE tag_lookup_id = ANY(p_copy_ids)
     ORDER BY partner_id, tag_lookup_id
  ), ins AS (
    INSERT INTO partner_tags (partner_id, tag_lookup_id)
    SELECT partner_id, v_target FROM src
    ON CONFLICT (partner_id, tag_lookup_id) DO NOTHING
    RETURNING partner_id
  )
  INSERT INTO tag_promotion_links (promotion_id, kind, record_id, from_tag_id, to_tag_id)
  SELECT v_promo, 'partner', s.partner_id, s.from_tag, v_target FROM src s JOIN ins USING (partner_id);

  -- The copies go quiet (their links stay).
  UPDATE lookups SET is_active = false, updated_at = now() WHERE id = ANY(p_copy_ids);

  RETURN v_promo;
END $$;

-- ── undo_tag_promotion ──
-- Reverses one promotion exactly. Returns a one-line receipt.
CREATE OR REPLACE FUNCTION undo_tag_promotion(p_promotion_id uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  p tag_promotions%ROWTYPE;
  v_leads int; v_partners int; v_copies int;
  v_tag text := 'kept';
BEGIN
  SELECT * INTO p FROM tag_promotions WHERE id = p_promotion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'undo_tag_promotion: no such promotion'; END IF;
  IF p.undone_at IS NOT NULL THEN RAISE EXCEPTION 'undo_tag_promotion: already undone at %', p.undone_at; END IF;

  DELETE FROM lead_tags lt USING tag_promotion_links l
   WHERE l.promotion_id = p.id AND l.kind = 'lead'
     AND lt.lead_id = l.record_id AND lt.tag_lookup_id = l.to_tag_id;
  GET DIAGNOSTICS v_leads = ROW_COUNT;
  DELETE FROM partner_tags pt USING tag_promotion_links l
   WHERE l.promotion_id = p.id AND l.kind = 'partner'
     AND pt.partner_id = l.record_id AND pt.tag_lookup_id = l.to_tag_id;
  GET DIAGNOSTICS v_partners = ROW_COUNT;

  UPDATE lookups lk SET is_active = c.was_active, updated_at = now()
    FROM tag_promotion_copies c
   WHERE c.promotion_id = p.id AND lk.id = c.tag_id;
  GET DIAGNOSTICS v_copies = ROW_COUNT;

  IF p.corporate_tag_created THEN
    -- Remove it only if nobody has been given it since; otherwise switch it
    -- off so the people tagged by hand keep their (restorable) link.
    IF NOT EXISTS (SELECT 1 FROM lead_tags WHERE tag_lookup_id = p.corporate_tag_id)
       AND NOT EXISTS (SELECT 1 FROM partner_tags WHERE tag_lookup_id = p.corporate_tag_id) THEN
      DELETE FROM lookups WHERE id = p.corporate_tag_id;
      v_tag := 'removed';
    ELSE
      UPDATE lookups SET is_active = false, updated_at = now() WHERE id = p.corporate_tag_id;
      v_tag := 'switched off (used by hand since)';
    END IF;
  ELSIF p.target_was_active IS NOT NULL AND NOT p.target_was_active THEN
    UPDATE lookups SET is_active = false, updated_at = now() WHERE id = p.corporate_tag_id;
    v_tag := 'switched back off';
  END IF;

  UPDATE tag_promotions SET undone_at = now() WHERE id = p.id;
  RETURN format('undone: %s client links and %s Network links removed, %s copies restored, corporate tag %s',
                v_leads, v_partners, v_copies, v_tag);
END $$;
