-- migrations/welcome_skip_overdue.sql
--
-- Kevin's decision (2026-10-17): of the 37 welcome emails held since 29 Sep by
-- the unsubscribe-token fault, the 13 MORE THAN 7 DAYS LATE are SKIPPED, not
-- sent — one arriving up to 18 days late is worse than none. The other 24 send
-- normally once the cache fix is live (oldest about 6 days late). Must run BEFORE the send-drips cache fix deploys — the fix
-- would otherwise release these 13 with the rest on the next hourly run.
--
-- The fault: Next.js's Data Cache served the cron a stale "no token" for each
-- lead, so the CAN-SPAM footer could not be built and every hourly retry was
-- refused (proven from Supabase edge logs 2026-10-17).
--
-- What this does, and does NOT do:
--   · welcome_email_scheduled_at → NULL. The app's existing cancel: the cron's
--     welcome query, the overdue alert and the timeline's "scheduled" line all
--     read this column, so nothing picks them up again.
--   · records the skip in three new columns, so the data says "skipped", never
--     "sent": welcome_email_skipped_at, welcome_email_skip_reason, and
--     welcome_email_skipped_due_at (when it was due — and what the undo restores).
--   · welcome_email_sent_at is NOT touched. Nothing is deleted.
--   · adds one timeline note per lead, so the owner sees their first email never
--     went out.
--
-- The 13 are pinned BY ID, not by "overdue now" — so neither the other 24 nor
-- the 9 welcomes due later on 2026-10-17 can be swept in, whenever this runs. A lead that got its
-- welcome in the meantime (welcome_email_sent_at set) is left alone by the guard.
--
-- RUN BETWEEN HOURLY CRON RUNS (not at :00). Steps 1–3 in order; 0 is the dry run.

-- ── 0. DRY RUN (read-only) ─────────────────────────────────────────────────
-- Expect 13 rows, would_skip = true on each (false = already sent or already
-- cancelled, and will be left alone).
WITH ids(id) AS (SELECT unnest(ARRAY[
  '22af0998-8d27-425f-b7e2-146b514eccff',
  'b6179271-b462-4e44-acf0-2cca53d009d1',
  '6c3d1e2c-1294-47ad-8279-c7da0096bb7e',
  '9ad943e2-7abb-4dbf-9fe2-f4ab41292be3',
  '28e37034-a118-4b6f-bc4f-28a1e0f88393',
  'fee901e7-4b78-433e-94ca-7dc3f770851d',
  'fb5d02c7-d5fe-4e16-8a49-6f02b12bc729',
  '07c91528-4fab-47cf-926d-5e654c8eb030',
  'ac25cbf4-26a3-456d-a3e6-f7348cb0d7c2',
  'd1676570-fde4-42ab-9b3d-11a1cc1af0fb',
  '995611da-a417-422a-b4c8-72c5aa98748b',
  'e6991792-b10f-4a36-9c31-33410a2181b2',
  '712743d3-3225-4380-9308-735facbc68a3'
]::uuid[]))
SELECT l.id, loc.name AS location, l.welcome_email_scheduled_at AS due_at,
       round(extract(epoch FROM now() - l.welcome_email_scheduled_at) / 86400, 1) AS days_late,
       l.paused, l.stage,
       (l.welcome_email_scheduled_at IS NOT NULL AND l.welcome_email_sent_at IS NULL) AS would_skip
FROM ids JOIN leads l ON l.id = ids.id JOIN locations loc ON loc.id = l.location_uuid
ORDER BY l.welcome_email_scheduled_at;

-- ── 1. Columns ─────────────────────────────────────────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS welcome_email_skipped_at     timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS welcome_email_skip_reason    text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS welcome_email_skipped_due_at timestamptz;

-- ── 2. Skip + timeline note, ONE statement ─────────────────────────────────
-- One statement on purpose: the Supabase editor drops temp tables between
-- statements, and the note must land for exactly the rows that were skipped.
WITH ids(id) AS (SELECT unnest(ARRAY[
  '22af0998-8d27-425f-b7e2-146b514eccff',
  'b6179271-b462-4e44-acf0-2cca53d009d1',
  '6c3d1e2c-1294-47ad-8279-c7da0096bb7e',
  '9ad943e2-7abb-4dbf-9fe2-f4ab41292be3',
  '28e37034-a118-4b6f-bc4f-28a1e0f88393',
  'fee901e7-4b78-433e-94ca-7dc3f770851d',
  'fb5d02c7-d5fe-4e16-8a49-6f02b12bc729',
  '07c91528-4fab-47cf-926d-5e654c8eb030',
  'ac25cbf4-26a3-456d-a3e6-f7348cb0d7c2',
  'd1676570-fde4-42ab-9b3d-11a1cc1af0fb',
  '995611da-a417-422a-b4c8-72c5aa98748b',
  'e6991792-b10f-4a36-9c31-33410a2181b2',
  '712743d3-3225-4380-9308-735facbc68a3'
]::uuid[])),
skipped AS (
  UPDATE leads l
     SET welcome_email_skipped_due_at = l.welcome_email_scheduled_at,
         welcome_email_skipped_at     = now(),
         welcome_email_skip_reason    = 'overdue_send_fault_2026_10',
         welcome_email_scheduled_at   = NULL,
         updated_at                   = now()
    FROM ids
   WHERE l.id = ids.id
     AND l.welcome_email_scheduled_at IS NOT NULL
     AND l.welcome_email_sent_at IS NULL
  RETURNING l.id, l.location_uuid, l.welcome_email_skipped_due_at
)
INSERT INTO touchpoints (lead_id, location_uuid, kind, method, label, notes, status, occurred_at)
SELECT s.id, s.location_uuid, 'system', 'system', 'Welcome email not sent',
       'Their welcome email was due on ' || to_char(s.welcome_email_skipped_due_at AT TIME ZONE 'UTC', 'FMDD Mon') ||
       ' but was held up by a fault on our side, and by the time it was fixed it was too late to send. ' ||
       'Nothing went out. They may be worth a call.',
       'done', now()
FROM skipped s
RETURNING lead_id;

-- ── 3. Verify ──────────────────────────────────────────────────────────────
-- Expect skipped = 13, still_scheduled = 0, sent = 0, notes = 13.
WITH ids(id) AS (SELECT unnest(ARRAY[
  '22af0998-8d27-425f-b7e2-146b514eccff',
  'b6179271-b462-4e44-acf0-2cca53d009d1',
  '6c3d1e2c-1294-47ad-8279-c7da0096bb7e',
  '9ad943e2-7abb-4dbf-9fe2-f4ab41292be3',
  '28e37034-a118-4b6f-bc4f-28a1e0f88393',
  'fee901e7-4b78-433e-94ca-7dc3f770851d',
  'fb5d02c7-d5fe-4e16-8a49-6f02b12bc729',
  '07c91528-4fab-47cf-926d-5e654c8eb030',
  'ac25cbf4-26a3-456d-a3e6-f7348cb0d7c2',
  'd1676570-fde4-42ab-9b3d-11a1cc1af0fb',
  '995611da-a417-422a-b4c8-72c5aa98748b',
  'e6991792-b10f-4a36-9c31-33410a2181b2',
  '712743d3-3225-4380-9308-735facbc68a3'
]::uuid[]))
SELECT
  count(*) FILTER (WHERE l.welcome_email_skip_reason = 'overdue_send_fault_2026_10')       AS skipped,
  count(*) FILTER (WHERE l.welcome_email_scheduled_at IS NOT NULL)          AS still_scheduled,
  count(*) FILTER (WHERE l.welcome_email_sent_at IS NOT NULL)               AS sent,
  (SELECT count(*) FROM touchpoints t JOIN ids i2 ON i2.id = t.lead_id
    WHERE t.kind = 'system' AND t.label = 'Welcome email not sent')                       AS notes
FROM ids JOIN leads l ON l.id = ids.id;
