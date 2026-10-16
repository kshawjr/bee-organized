-- migrations/relationship_to_tags.sql
--
-- PURPOSE
--   The Network "relationship" field is retired into the one tag list
--   (lib/tags.ts), Kevin's ruling 2026-10-15:
--     Vendor  → a NEW corporate tag "Vendor"  (🧰), tagged
--     Friend  → a NEW corporate tag "Friend"  (👋), tagged
--     Realtor → the EXISTING "Realtor" tag (slug real-estate), tagged —
--               unless the person already carries it
--     Other   → left untagged: the value carries no meaning
--     blank   → nothing
--
-- MEASURED ON PRODUCTION 2026-10-15 (before running)
--   214 people: 176 blank, Vendor 18 (1 of them soft-deleted), Other 12,
--   Realtor 7 (4 already tagged Realtor), Friend 1. No Vendor or Friend
--   lookup exists in any list. Expected links: 18 + 1 + 3 = 22.
--
-- WHAT IT DOES NOT DO
--   partners.relationship keeps every value it has — it is marked DEAD by a
--   database comment, like leads.tags / partners.tags / partners.specialties
--   from the tag merge. Dropping it is a separate decision.
--   Soft-deleted people are tagged too (the merge's rule): restored, they
--   come back with their tags.
--
-- SAFE TO RE-RUN
--   The two tags are created only if missing. Every link this file makes is
--   written to relationship_tag_log; a re-run skips any pair already in the
--   log, so it never puts back a tag an owner removed.
--
-- ORDER WITH THE CODE
--   Either order is safe (this only adds tags + links + a comment; the
--   column is untouched). Running it AFTER the screens stop offering the
--   field means nothing can be set in between; a re-run catches it anyway.
--
-- HOW TO UNDO
--   migrations/relationship_to_tags_undo.sql
--
-- Supabase SQL editor note: no temp tables; each step is one statement.

-- ── 1. the two new corporate tags (only if missing, in any state) ──
-- Placed after every existing tag (max sort_order today is 3010).
-- attrs.created_by marks them as this migration's, for the undo.
INSERT INTO lookups (category, label, icon, sort_order, attrs, location_id, is_active)
SELECT 'tags', v.label, v.icon, v.sort_order,
       jsonb_build_object('key', v.key, 'created_by', 'relationship_to_tags'),
       NULL, true
FROM (VALUES ('Vendor', '🧰', 'vendor', 3020),
             ('Friend', '👋', 'friend', 3030)) AS v(label, icon, key, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM lookups l
  WHERE l.category = 'tags' AND l.location_id IS NULL AND lower(l.label) = lower(v.label)
);

-- ── 2. the receipt table ──
CREATE TABLE IF NOT EXISTS relationship_tag_log (
  partner_id     uuid        NOT NULL,
  tag_lookup_id  uuid        NOT NULL,
  relationship   text        NOT NULL,
  copied_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, tag_lookup_id)
);
-- Service-role only, like partner_tags / tag_merge_log.
ALTER TABLE relationship_tag_log ENABLE ROW LEVEL SECURITY;

-- ── 3. the links — one statement ──
-- Matching is exact on the trimmed value (production holds exactly
-- 'Vendor', 'Friend', 'Realtor', 'Other' and blanks). A person who
-- already carries the tag is skipped by ON CONFLICT and NOT logged, so
-- the undo never removes a tag they had before this ran.
WITH map AS (
  SELECT 'Vendor'  AS relationship, 'vendor'      AS slug UNION ALL
  SELECT 'Friend',                  'friend'               UNION ALL
  SELECT 'Realtor',                 'real-estate'
),
src AS (
  SELECT p.id AS partner_id, l.id AS tag_lookup_id, m.relationship
  FROM partners p
  JOIN map m ON m.relationship = trim(p.relationship)
  JOIN lookups l
    ON l.category = 'tags' AND l.location_id IS NULL AND l.attrs->>'key' = m.slug
  WHERE NOT EXISTS (
    SELECT 1 FROM relationship_tag_log g
    WHERE g.partner_id = p.id AND g.tag_lookup_id = l.id
  )
),
ins AS (
  INSERT INTO partner_tags (partner_id, tag_lookup_id)
  SELECT partner_id, tag_lookup_id FROM src
  ON CONFLICT (partner_id, tag_lookup_id) DO NOTHING
  RETURNING partner_id, tag_lookup_id
)
INSERT INTO relationship_tag_log (partner_id, tag_lookup_id, relationship)
SELECT s.partner_id, s.tag_lookup_id, s.relationship
FROM src s
JOIN ins USING (partner_id, tag_lookup_id)
ON CONFLICT DO NOTHING;

-- ── 4. mark the column dead (comment only — nothing dropped) ──
COMMENT ON COLUMN partners.relationship IS
  'DEAD (relationship → tags, 2026-10-15): Vendor/Friend/Realtor copied into partner_tags by migrations/relationship_to_tags.sql (receipt: relationship_tag_log); "Other" carried no meaning and was not copied. No longer read or written. Candidate to drop — separate decision.';

-- ── 5. the receipt — read this before saying it worked ──
-- Expect on the first run: vendor 18, friend 1, realtor 3, logged 22,
-- realtor_skipped_already_tagged 4, tags_created 2.
SELECT
  (SELECT count(*) FROM relationship_tag_log WHERE relationship = 'Vendor')  AS vendor,
  (SELECT count(*) FROM relationship_tag_log WHERE relationship = 'Friend')  AS friend,
  (SELECT count(*) FROM relationship_tag_log WHERE relationship = 'Realtor') AS realtor,
  (SELECT count(*) FROM relationship_tag_log)                                AS logged,
  (SELECT count(*) FROM partners p
     JOIN lookups l ON l.category = 'tags' AND l.location_id IS NULL AND l.attrs->>'key' = 'real-estate'
     JOIN partner_tags pt ON pt.partner_id = p.id AND pt.tag_lookup_id = l.id
    WHERE trim(p.relationship) = 'Realtor'
      AND NOT EXISTS (SELECT 1 FROM relationship_tag_log g
                       WHERE g.partner_id = p.id AND g.tag_lookup_id = l.id)) AS realtor_skipped_already_tagged,
  (SELECT count(*) FROM lookups WHERE attrs->>'created_by' = 'relationship_to_tags') AS tags_created;
