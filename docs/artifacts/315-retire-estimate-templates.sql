-- issue 315 — retire the four estimate follow-up masters (DATA, NOT RUN)
--
-- Kevin runs this. It is not executed by any code in this change, and issue
-- 315 ships without it: the code change only stops the library presenting a
-- retired row as a live one. This flips four rows that ARE retired in every
-- sense except the flag.
--
-- ── WHAT THEY ARE ──────────────────────────────────────────────────────────
-- The four opp_*_estimate_* follow-ups were retired in issue 240 step 3
-- (ec04aee) because Jobber sends its own estimate follow-ups and ours arrived
-- alongside them for the client. 80 scheduled rows were cancelled then. The
-- templates rows were left is_active = true, so they still read as live in
-- Admin → Content.
--
-- ── DOES ANYTHING STILL SEND THEM?  NO.  Verified 2026-08-19 against prod ──
--
-- 1. NOTHING SCHEDULES THEM. lib/stage-emails.ts:161 — the only branch that
--    builds rows is `if (newStage === 'Closed Won')`, which uses
--    CLOSED_WON_TRIGGERS. The 'Estimate Sent' branch returns without
--    scheduling. The four keys stay DEFINED (ALL_STAGE_EMAIL_KEYS scopes
--    cancellation over them; TRANSACTIONAL_STAGE_EMAIL_KEYS picks their
--    wrapper) but nothing writes a row.
--
-- 2. NOTHING IS QUEUED. scheduled_stage_emails, all four keys:
--        opp_organizing_estimate_3d    115 rows —  59 sent, 56 cancelled, 0 pending
--        opp_organizing_estimate_30d   115 rows —   5 sent, 110 cancelled, 0 pending
--        opp_moving_estimate_3d          8 rows —   3 sent,  5 cancelled, 0 pending
--        opp_moving_estimate_30d         8 rows —   0 sent,  8 cancelled, 0 pending
--    Zero pending across all four. Nothing for the cron to pick up.
--
-- 3. NO DRIP STEP POINTS AT THEM. drip_path_steps.master_template_id joined
--    against these four ids: 0 rows. (The only master-linked steps in
--    production are 3 on Test Location — 2 → 'Test Custom', 1 → 'Test 2
--    Email' — plus 1 → opp_closed_job_12mo. None of them is an estimate.)
--
-- 4. THE PICKER ALREADY REFUSES THEM. All four legacy_ids are in
--    ADD_STEP_EXCLUDED_LEGACY_IDS, so "+ Add another email" cannot offer them
--    regardless of this flag. Flipping is_active does not change that; it is
--    belt to the existing braces.
--
-- ── WHY THIS IS SAFE EVEN IF A ROW APPEARS LATER ──────────────────────────
-- sendStageEmail resolves its template by legacy_id + location_uuid IS NULL
-- and does NOT filter is_active (lib/stage-emails.ts:277-282). So a pending
-- row that somehow outlived the sweep still renders and completes correctly
-- after this UPDATE, exactly as ec04aee intended when it kept the sender
-- wired. This flag is a LIBRARY label, not a send gate. Do not add an
-- is_active filter to the send path to "finish the job" — that would break
-- the property this UPDATE relies on.
--
-- ── WHAT CHANGES ON SCREEN ────────────────────────────────────────────────
--   Admin → Content → Email Templates (Master): the four move out of the live
--     shelf and into the collapsed "⊘ Retired" block, badged. Still reachable.
--   Owner → Settings → Texts & scripts: they leave the "📈 Opportunity Stages"
--     group entirely (that surface filters `t.isMaster && t.isActive`). The
--     two closed-job masters stay, so the group does not empty out. NOTE: the
--     group's caption still says "The Estimate Sent follow-ups were retired in
--     issue 240 step 3 — Jobber sends its own." That sentence stays true and
--     stays useful, but it will then describe rows that are no longer on that
--     screen. Kevin's call whether to trim it; not trimmed here.
--   Owner → Settings → Emails: unchanged. Rail C is the closed-job pair only.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   UPDATE templates SET is_active = true
--    WHERE legacy_id IN ('opp_organizing_estimate_3d','opp_organizing_estimate_30d',
--                        'opp_moving_estimate_3d','opp_moving_estimate_30d')
--      AND location_uuid IS NULL;

-- ── DRY RUN — read this first, confirm it is exactly 4 rows ───────────────
SELECT id, name, legacy_id, is_active
  FROM templates
 WHERE legacy_id IN (
         'opp_organizing_estimate_3d',
         'opp_organizing_estimate_30d',
         'opp_moving_estimate_3d',
         'opp_moving_estimate_30d')
   AND location_uuid IS NULL
 ORDER BY legacy_id;

-- Expected, as of 2026-08-19:
--   48f6d928-6840-44cb-b1c2-35d33beb92f5  Opportunity · Moving Estimate — 3 day follow up       opp_moving_estimate_3d       t
--   c534ef71-1cb2-4df5-a06d-ea06a4f25002  Opportunity · Moving Estimate — 30 day follow up      opp_moving_estimate_30d      t
--   999b4231-0994-425d-a3b7-6e14d88dffed  Opportunity · Organizing Estimate — 3 day follow up   opp_organizing_estimate_3d   t
--   9bd0470f-8ef9-492f-be47-255bb1e8157f  Opportunity · Organizing Estimate — 30 day follow up  opp_organizing_estimate_30d  t

-- ── THE WRITE — by explicit id, never by predicate ────────────────────────
-- Ids, not legacy_ids, so a row renamed or re-keyed between the dry run above
-- and this statement cannot be swept up by a predicate that still matches it.
UPDATE templates
   SET is_active = false,
       updated_at = now()
 WHERE id IN (
         '999b4231-0994-425d-a3b7-6e14d88dffed',  -- opp_organizing_estimate_3d
         '9bd0470f-8ef9-492f-be47-255bb1e8157f',  -- opp_organizing_estimate_30d
         '48f6d928-6840-44cb-b1c2-35d33beb92f5',  -- opp_moving_estimate_3d
         'c534ef71-1cb2-4df5-a06d-ea06a4f25002')  -- opp_moving_estimate_30d
   AND is_active = true;
-- Expect: UPDATE 4. Anything else — STOP and re-read the dry run.

-- ── VERIFY ────────────────────────────────────────────────────────────────
-- Masters should go 6 active → 2 active (the closed-job pair, which STAY:
-- they are live, 256 rows pending across the two keys).
SELECT count(*) FILTER (WHERE is_active)     AS masters_active,
       count(*) FILTER (WHERE NOT is_active) AS masters_retired
  FROM templates WHERE location_uuid IS NULL;
-- Expected after: masters_active = 2, masters_retired = 24
