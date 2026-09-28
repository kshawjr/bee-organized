-- migrations/strip_google_reviews_asterisks.sql
--
-- Take the literal ** off "Be sure to check out our Google Reviews!" in the
-- 10 live emails that carry it. Kevin's call, 2026-09-27: strip now, consider
-- bold rendering later.
--
-- WHY. Client emails go out as plain paragraphs. The branded drip layout
-- (lib/drip-email-layout.ts) linkifies but has no Markdown step, so
-- "**Be sure to check out our Google Reviews!**" has reached clients with the
-- asterisks showing — on step 1, the FIRST email a new lead gets — since at
-- least mid-July. The line came from migrations/seed_master_drip_paths.sql
-- (moving-c step 1), which is fixed in the same commit as this file.
--
-- SCOPE, checked against production on 2026-09-27. These 10 rows are EVERY
-- asterisk in templates and drip_path_steps — bodies and subjects, active and
-- inactive, masters and location copies. Nothing else a client email is built
-- from (hub_users.signature_title, locations.name / sender_name) has one.
--
--   drip_path_steps (step 1)
--     4ffd555c-…  master  · moving-c        ({{reviews_link}})
--     a39eb127-…  Central Austin · moving-c ({{reviews_link}})
--     a0e15aeb-…  New Braunfels  · moving-c ({{reviews_link}})
--     cc58766d-…  North Houston  · moving-c ({{reviews_link}})
--     45023cc3-…  Sioux Falls    · moving-c ({{reviews_link}})
--     c5779834-…  South Charlotte· moving-c ({{reviews_link}})
--     6becd2bc-…  Test Location  · moving-c ({{reviews_link}})
--     137855d8-…  Kansas City · organizing-a  (their own Google link, bare)
--   templates (Kansas City's own, not copies of a master)
--     2317e195-…  KC Move Intro Email  (their own link, in brackets) —
--                 the wording behind KC's moving-c step 1
--     fefc3147-…  KC Organizing Intro Template (their own link, bare) —
--                 not used by any step
--
-- WHAT CHANGES. Only the four asterisks. The replace() below turns
--   **Be sure to check out our Google Reviews!**
-- into
--   Be sure to check out our Google Reviews!
-- and nothing else: same words, same line break, same link after it (KC's
-- hand-typed link included). Each row holds that phrase exactly once.
--
-- AN OWNER'S EDIT IS NEVER OVERWRITTEN. Each row is matched on its id AND
-- the md5 of its body as read on 2026-09-27 (before_md5). A row whose owner
-- has changed ANY character since then does not match, is NOT touched, and
-- is reported as "CHANGED SINCE 2026-09-27 — not touched" by the SELECT at
-- the end. Look at that row by hand; if it still carries the asterisks, strip
-- them in Settings › Emails or send it back for a fresh fingerprint.
--
-- SAFE TO RUN TWICE. After the first run each body's md5 is after_md5, so a
-- second run matches nothing and the report says "done". Nothing is inserted
-- or deleted.
--
-- SIDE EFFECT: updated_at. Both tables have a BEFORE UPDATE trigger that
-- stamps updated_at, so the rows that change show 2026-09-27 (or whenever
-- this runs) as their last edit. Checked harmless: the only logic that reads
-- updated_at is fork resolution (lib/template-fork.ts), and neither KC
-- template is a fork (cloned_from_id NULL).
--
-- RUN HISTORY. Kevin ran the first version of this file on 2026-09-28
-- 03:20:25 UTC. Its two UPDATEs committed and did exactly what they should:
-- a read-back against a snapshot taken before the run found all 10 rows with
-- only the ** removed, the other 190 template / step bodies byte-for-byte
-- unchanged, and no asterisk left in any template or drip step. Its closing
-- report failed with 42P01 (relation "strip_reviews_targets" does not exist):
-- that version kept the target list in a TEMP TABLE, and the Supabase SQL
-- editor does not keep one alive across every statement of a script.
--
-- THIS VERSION has no temp table and no BEGIN/COMMIT. The strip and its
-- report are ONE statement (the target list is a CTE, the two UPDATEs are
-- data-modifying CTEs, the report reads their RETURNING), so it is atomic on
-- its own and works however the editor sends it. Run it now and it changes
-- nothing: every row reports "done".
--
-- The report: 10 rows, each "stripped" (this run changed it), "done" (already
-- stripped), "CHANGED SINCE 2026-09-27 — not touched" (an owner edited it;
-- check by hand), or "ROW GONE".

WITH targets (tbl, id, label, before_md5, after_md5) AS (VALUES
  ('drip_path_steps', '4ffd555c-e879-47ef-b92a-479c97ec2e2a'::uuid, 'master · moving-c step 1',          '06c724dcc2f0fbd097a1950cae337a5c', '9e39ee30144330b96838aa22b1badac4'),
  ('drip_path_steps', 'a39eb127-c0d9-4f64-bfde-b08407500123'::uuid, 'Central Austin · moving-c step 1',  '06c724dcc2f0fbd097a1950cae337a5c', '9e39ee30144330b96838aa22b1badac4'),
  ('drip_path_steps', 'a0e15aeb-b0b0-40ca-8ca4-43aef6ba69c9'::uuid, 'New Braunfels · moving-c step 1',   'c27622993e42fa5726f379a2b4e62233', '0e67dc17dcfaac59a344d6ca1e3eb1be'),
  ('drip_path_steps', 'cc58766d-a1fa-405c-8067-bc5c33ff92b5'::uuid, 'North Houston · moving-c step 1',   '0875cb2fa21d02175a324a71548dc334', 'df90ca23b61938ab09ae9c1ea8ffb299'),
  ('drip_path_steps', '45023cc3-6c74-4c9b-8360-55ab6656c027'::uuid, 'Sioux Falls · moving-c step 1',     'e4669241a11b42aa61c7a237b587d8d6', '106288efabf326c19b8efaa6c6fb6a4c'),
  ('drip_path_steps', 'c5779834-7649-48c3-80f0-ff651f2e924a'::uuid, 'South Charlotte · moving-c step 1', '3e21b7e340be854a2589c9433161abe0', '89d15727f19ff9fa581e4925547bdd32'),
  ('drip_path_steps', '6becd2bc-6706-44e6-a6e1-cec0fcbd9bbd'::uuid, 'Test Location · moving-c step 1',   '06c724dcc2f0fbd097a1950cae337a5c', '9e39ee30144330b96838aa22b1badac4'),
  ('drip_path_steps', '137855d8-49a5-435f-8216-bdea79c1f6c4'::uuid, 'Kansas City · organizing-a step 1', 'b69f2d78877f964ddf7f629469579c65', 'e31222752f226e1462cb56f4a6e16619'),
  ('templates',       '2317e195-25fd-444c-a719-8652b5799794'::uuid, 'KC Move Intro Email',               '4a41a73fe72fa8c2465c402784ed5fbc', 'e4ee14fb5f2d5818cb7479a1d4507874'),
  ('templates',       'fefc3147-8a89-44a2-b16d-d7490bcdef32'::uuid, 'KC Organizing Intro Template',      '339f8acbc2c6b060f2cce6bee0993eb0', 'fde535e6d9005c9072f2e400d9e4796e')
),
steps AS (
  UPDATE drip_path_steps s
  SET body = replace(s.body, '**Be sure to check out our Google Reviews!**', 'Be sure to check out our Google Reviews!')
  FROM targets x
  WHERE x.tbl = 'drip_path_steps' AND s.id = x.id AND md5(s.body) = x.before_md5
  RETURNING s.id, s.body
),
tpls AS (
  UPDATE templates t
  SET body = replace(t.body, '**Be sure to check out our Google Reviews!**', 'Be sure to check out our Google Reviews!')
  FROM targets x
  WHERE x.tbl = 'templates' AND t.id = x.id AND md5(t.body) = x.before_md5
  RETURNING t.id, t.body
),
changed AS (SELECT id, body FROM steps UNION ALL SELECT id, body FROM tpls),
-- Bodies as they stood when this statement began (a statement cannot see
-- its own UPDATEs except through RETURNING — hence "changed" above).
existing AS (
  SELECT id, body FROM drip_path_steps WHERE id IN (SELECT id FROM targets WHERE tbl = 'drip_path_steps')
  UNION ALL
  SELECT id, body FROM templates       WHERE id IN (SELECT id FROM targets WHERE tbl = 'templates')
)
SELECT x.label,
  CASE
    WHEN c.id IS NOT NULL                THEN 'stripped'
    WHEN e.id IS NULL                    THEN 'ROW GONE — deleted since 2026-09-27'
    WHEN md5(e.body) = x.after_md5       THEN 'done (already stripped by an earlier run)'
    ELSE 'CHANGED SINCE 2026-09-27 — not touched; check it by hand'
  END AS result,
  position('*' in coalesce(c.body, e.body, '')) > 0 AS still_has_asterisk
FROM targets x
LEFT JOIN changed  c ON c.id = x.id
LEFT JOIN existing e ON e.id = x.id
ORDER BY x.tbl, x.label;

-- ─── ROLLBACK ────────────────────────────────────────────────────────
-- Puts the ** back on exactly the rows this stripped, and only while their
-- body is still byte-for-byte what this migration left (after_md5). A row an
-- owner has edited since is left alone, same rule as above. One statement,
-- no temp table; it returns the rows it restored.
--
--   WITH targets (tbl, id, label, before_md5, after_md5) AS (VALUES
--     ('drip_path_steps', '4ffd555c-e879-47ef-b92a-479c97ec2e2a'::uuid, 'master · moving-c step 1',          '06c724dcc2f0fbd097a1950cae337a5c', '9e39ee30144330b96838aa22b1badac4'),
--     ('drip_path_steps', 'a39eb127-c0d9-4f64-bfde-b08407500123'::uuid, 'Central Austin · moving-c step 1',  '06c724dcc2f0fbd097a1950cae337a5c', '9e39ee30144330b96838aa22b1badac4'),
--     ('drip_path_steps', 'a0e15aeb-b0b0-40ca-8ca4-43aef6ba69c9'::uuid, 'New Braunfels · moving-c step 1',   'c27622993e42fa5726f379a2b4e62233', '0e67dc17dcfaac59a344d6ca1e3eb1be'),
--     ('drip_path_steps', 'cc58766d-a1fa-405c-8067-bc5c33ff92b5'::uuid, 'North Houston · moving-c step 1',   '0875cb2fa21d02175a324a71548dc334', 'df90ca23b61938ab09ae9c1ea8ffb299'),
--     ('drip_path_steps', '45023cc3-6c74-4c9b-8360-55ab6656c027'::uuid, 'Sioux Falls · moving-c step 1',     'e4669241a11b42aa61c7a237b587d8d6', '106288efabf326c19b8efaa6c6fb6a4c'),
--     ('drip_path_steps', 'c5779834-7649-48c3-80f0-ff651f2e924a'::uuid, 'South Charlotte · moving-c step 1', '3e21b7e340be854a2589c9433161abe0', '89d15727f19ff9fa581e4925547bdd32'),
--     ('drip_path_steps', '6becd2bc-6706-44e6-a6e1-cec0fcbd9bbd'::uuid, 'Test Location · moving-c step 1',   '06c724dcc2f0fbd097a1950cae337a5c', '9e39ee30144330b96838aa22b1badac4'),
--     ('drip_path_steps', '137855d8-49a5-435f-8216-bdea79c1f6c4'::uuid, 'Kansas City · organizing-a step 1', 'b69f2d78877f964ddf7f629469579c65', 'e31222752f226e1462cb56f4a6e16619'),
--     ('templates',       '2317e195-25fd-444c-a719-8652b5799794'::uuid, 'KC Move Intro Email',               '4a41a73fe72fa8c2465c402784ed5fbc', 'e4ee14fb5f2d5818cb7479a1d4507874'),
--     ('templates',       'fefc3147-8a89-44a2-b16d-d7490bcdef32'::uuid, 'KC Organizing Intro Template',      '339f8acbc2c6b060f2cce6bee0993eb0', 'fde535e6d9005c9072f2e400d9e4796e')
--   ),
--   steps AS (
--     UPDATE drip_path_steps s SET body = replace(s.body, 'Be sure to check out our Google Reviews!', '**Be sure to check out our Google Reviews!**')
--     FROM targets x WHERE x.tbl = 'drip_path_steps' AND s.id = x.id AND md5(s.body) = x.after_md5
--     RETURNING x.label
--   ),
--   tpls AS (
--     UPDATE templates t SET body = replace(t.body, 'Be sure to check out our Google Reviews!', '**Be sure to check out our Google Reviews!**')
--     FROM targets x WHERE x.tbl = 'templates' AND t.id = x.id AND md5(t.body) = x.after_md5
--     RETURNING x.label
--   )
--   SELECT label AS restored FROM steps UNION ALL SELECT label FROM tpls ORDER BY 1;
--
-- updated_at is not restored (the trigger stamps it again); nothing reads it
-- for these rows.
