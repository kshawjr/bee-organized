-- migrations/tag_merge_1_copy.sql
--
-- PURPOSE
--   Tag merge, step 1 of 2: every Network person's specialties become tags.
--   Each value in partners.specialties (a slug, e.g. 'real-estate') is
--   turned into a partner_tags link to the matching corporate lookups row
--   (the row whose attrs->>'key' is that slug — 'Realtor').
--
-- WHAT IT DOES NOT DO
--   It does not touch partners.specialties. The column keeps every value it
--   has today; it is simply no longer read or written by the app (see
--   lib/tags.ts). Dropping it is a separate decision.
--
-- MEASURED ON PRODUCTION 2026-10-15 (before running)
--   86 people carry 100 specialty values over 17 distinct slugs (2 of them
--   on soft-deleted people); all 17
--   slugs match a corporate partner_specialties row; 13 people have more
--   than one. partner_tags holds 2 rows (the 'Partner' tag), none of which
--   is a specialty, so nothing here collides with an existing link.
--
-- SAFE TO RE-RUN — and meant to be (lib/tags.ts run order, step 3)
--   Every link this file makes is written to tag_merge_log. A re-run skips
--   any (person, tag) pair already in the log, so:
--     · a second run only copies specialties the OLD code wrote between
--       step 1 and the push;
--     · a tag an owner REMOVED after the first run is never put back.
--
-- HOW TO UNDO
--   migrations/tag_merge_1_copy_undo.sql — removes exactly the links listed
--   in tag_merge_log and nothing else.
--
-- Supabase SQL editor note: no temp tables (the editor drops them between
-- statements). tag_merge_log is a real table; the copy is ONE statement.

-- ── 1. the log (a real table, kept after the merge as the receipt) ──
CREATE TABLE IF NOT EXISTS tag_merge_log (
  partner_id     uuid        NOT NULL,
  tag_lookup_id  uuid        NOT NULL,
  specialty_key  text        NOT NULL,
  position       int         NOT NULL,   -- 1 = was the person's first specialty
  copied_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, tag_lookup_id)
);
-- Service-role only, like partner_tags / lead_tags.
ALTER TABLE tag_merge_log ENABLE ROW LEVEL SECURITY;

-- ── 2. the copy — one statement ──
-- Includes soft-deleted people too: if one is ever restored, their tags
-- come back with them. The lookup may be in 'partner_specialties' (before
-- step 2) or 'tags' (a re-run after step 2) — attrs->>'key' finds it in
-- either.
WITH src AS (
  SELECT DISTINCT ON (p.id, l.id)
         p.id      AS partner_id,
         l.id      AS tag_lookup_id,
         u.v       AS specialty_key,
         u.ord::int AS position
  FROM partners p
  CROSS JOIN LATERAL unnest(p.specialties) WITH ORDINALITY AS u(v, ord)
  JOIN lookups l
    ON l.category IN ('partner_specialties', 'tags')
   AND l.location_id IS NULL
   AND l.attrs->>'key' = u.v
  WHERE NOT EXISTS (
    SELECT 1 FROM tag_merge_log m
    WHERE m.partner_id = p.id AND m.tag_lookup_id = l.id
  )
  ORDER BY p.id, l.id, u.ord
),
ins AS (
  INSERT INTO partner_tags (partner_id, tag_lookup_id)
  SELECT partner_id, tag_lookup_id FROM src
  ON CONFLICT (partner_id, tag_lookup_id) DO NOTHING
  RETURNING partner_id, tag_lookup_id
)
INSERT INTO tag_merge_log (partner_id, tag_lookup_id, specialty_key, position)
SELECT s.partner_id, s.tag_lookup_id, s.specialty_key, s.position
FROM src s
JOIN ins USING (partner_id, tag_lookup_id)
ON CONFLICT DO NOTHING;

-- ── 3. the receipt — read this before saying it worked ──
-- Expect on the first run: people_with_specialties 86, people_with_tags_now
-- ≥ 86, links_logged 100, unmatched_values 0.
SELECT
  (SELECT count(*) FROM partners WHERE cardinality(specialties) > 0)          AS people_with_specialties,
  (SELECT count(DISTINCT pt.partner_id) FROM partner_tags pt
     JOIN partners p ON p.id = pt.partner_id
    WHERE cardinality(p.specialties) > 0)                                     AS people_with_tags_now,
  (SELECT count(*) FROM tag_merge_log)                                        AS links_logged,
  (SELECT count(*) FROM partners p, unnest(p.specialties) v
    WHERE NOT EXISTS (SELECT 1 FROM lookups l
                       WHERE l.category IN ('partner_specialties', 'tags')
                         AND l.location_id IS NULL
                         AND l.attrs->>'key' = v))                             AS unmatched_values;
