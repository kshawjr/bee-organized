-- migrations/reminders_from_lost_followups.sql
--
-- Carry the lost-lead wizard's follow-ups over into Reminders.
--
-- WRITTEN, NOT RUN. Needs migrations/reminders.sql first (the table).
-- TWO STEPS: run STEP 1 on its own, read it, then run STEP 2.
--
-- WHAT THESE ARE. Until 2026-09-30, "Set a reminder to follow up later?" in
-- the Close-as-lost wizard wrote a touchpoints row — kind 'reach_out',
-- label "Follow-up · <what for>", user_id = the owner who answered,
-- occurred_at = the date they picked, at 9am — and nothing ever read it
-- back. The brief counts 13: 9 owners, 13 clients, 20 Aug → 22 Sep.
--
-- DUE TODAY (Kevin's ruling), in each location's own timezone, so they
-- surface at once and the owner decides. NOTE: the owner DID pick a date at
-- the time — it is occurred_at, shown in step 1 as picked_date. Kevin's
-- ruling was made believing there was none. If he would rather honour the
-- picked dates, swap the marked line in step 2 (past ones would then show
-- as overdue immediately, future ones on the day the owner chose).
--
-- OWNER = touchpoints.user_id, the person who answered the wizard. Rows
-- with no user_id, or whose user no longer exists, are listed and skipped.
-- The client is the lead's CURRENT row (location from leads, in case the
-- lead has since been transferred).
--
-- The old touchpoints are left exactly as they are (history). Nothing is
-- deleted or edited.

-- ═══ STEP 1 — PREVIEW (read-only) ═══════════════════════════════════════
WITH src AS (
  SELECT tp.id AS touchpoint_id, tp.user_id, tp.lead_id, tp.label, tp.created_at,
         tp.occurred_at, l.name AS client, l.location_uuid, loc.name AS location,
         COALESCE(hu.full_name, hu.email) AS owner,
         CASE loc.timezone
           WHEN 'Eastern Time (ET)'  THEN 'America/New_York'
           WHEN 'Central Time (CT)'  THEN 'America/Chicago'
           WHEN 'Mountain Time (MT)' THEN 'America/Denver'
           WHEN 'Arizona Time (AZ)'  THEN 'America/Phoenix'
           WHEN 'Pacific Time (PT)'  THEN 'America/Los_Angeles'
           WHEN 'Alaska Time (AKT)'  THEN 'America/Anchorage'
           WHEN 'Hawaii Time (HT)'   THEN 'Pacific/Honolulu'
           ELSE COALESCE(NULLIF(loc.timezone, ''), 'America/New_York')
         END AS tz,
         EXISTS (SELECT 1 FROM auth.users au WHERE au.id = tp.user_id) AS owner_exists
  FROM public.touchpoints tp
  LEFT JOIN public.leads l       ON l.id = tp.lead_id
  LEFT JOIN public.locations loc ON loc.id = l.location_uuid
  LEFT JOIN public.hub_users hu  ON hu.id = tp.user_id
  WHERE tp.kind = 'reach_out' AND tp.label LIKE 'Follow-up · %'
)
SELECT touchpoint_id, owner, client, location,
       substr(label, length('Follow-up · ') + 1)            AS note,
       created_at::date                                     AS written_on,
       (occurred_at AT TIME ZONE tz)::date                  AS picked_date,
       (now() AT TIME ZONE tz)::date                        AS would_be_due,
       CASE
         WHEN lead_id IS NULL OR client IS NULL THEN 'skip: client gone'
         WHEN user_id IS NULL                   THEN 'skip: nobody on file'
         WHEN NOT owner_exists                  THEN 'skip: that user no longer exists'
         WHEN EXISTS (SELECT 1 FROM public.reminders r
                      WHERE r.user_id = src.user_id AND r.lead_id = src.lead_id
                        AND r.note = substr(src.label, length('Follow-up · ') + 1))
                                                THEN 'skip: already carried over'
         ELSE 'CONVERT'
       END AS outcome
FROM src
ORDER BY outcome, location, owner, client;

-- ═══ STEP 2 — CONVERT (writes; run only after reading step 1) ═══════════
-- One statement, no temp tables. Safe to re-run: a follow-up already carried
-- over (same owner, client and note) is not copied twice.
WITH src AS (
  SELECT tp.user_id, tp.lead_id, l.location_uuid, tp.occurred_at,
         NULLIF(btrim(substr(tp.label, length('Follow-up · ') + 1)), '') AS note,
         CASE loc.timezone
           WHEN 'Eastern Time (ET)'  THEN 'America/New_York'
           WHEN 'Central Time (CT)'  THEN 'America/Chicago'
           WHEN 'Mountain Time (MT)' THEN 'America/Denver'
           WHEN 'Arizona Time (AZ)'  THEN 'America/Phoenix'
           WHEN 'Pacific Time (PT)'  THEN 'America/Los_Angeles'
           WHEN 'Alaska Time (AKT)'  THEN 'America/Anchorage'
           WHEN 'Hawaii Time (HT)'   THEN 'Pacific/Honolulu'
           ELSE COALESCE(NULLIF(loc.timezone, ''), 'America/New_York')
         END AS tz
  FROM public.touchpoints tp
  JOIN public.leads l       ON l.id = tp.lead_id
  JOIN public.locations loc ON loc.id = l.location_uuid
  WHERE tp.kind = 'reach_out' AND tp.label LIKE 'Follow-up · %'
    AND tp.user_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = tp.user_id)
)
INSERT INTO public.reminders (user_id, location_uuid, lead_id, due_on, note)
SELECT src.user_id, src.location_uuid, src.lead_id,
       (now() AT TIME ZONE src.tz)::date,          -- DUE TODAY (Kevin). To honour the picked date instead: (src.occurred_at AT TIME ZONE src.tz)::date
       left(COALESCE(src.note, 'follow up'), 500)
FROM src
WHERE NOT EXISTS (
  SELECT 1 FROM public.reminders r
  WHERE r.user_id = src.user_id AND r.lead_id = src.lead_id
    AND r.note = left(COALESCE(src.note, 'follow up'), 500)
)
RETURNING id, user_id, lead_id, due_on, note;
