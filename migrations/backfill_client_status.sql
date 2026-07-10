-- migrations/backfill_client_status.sql
--
-- Written 2026-07-09; execution authorized by Kevin 2026-07-10 after the
-- stale-won engagement repair (4dc7478) cleaned the underlying data.
-- Run in the Supabase SQL editor.
--
-- Adds + populates leads.client_status with the SAME precedence the live
-- derivation uses (components/hive/shared/clientStatus.js). The column
-- did not previously exist (the phase-1 "stored vs derived" question was
-- resolved derived-for-now); this lands the stored half as
-- belt-and-suspenders. The LIVE derivation does NOT read this column —
-- it derives from engagement outcomes on every load — so this backfill
-- is not a prerequisite for correct statuses in the app; it exists so
-- anything reading the stored column (reports, SQL, future server-side
-- filters) agrees with what the UI shows.
--
-- Precedence (mirror of deriveClientStatus — keep in sync):
--   no_contact — no email AND no phone
--   Active     — ≥1 open engagement (stage not terminal)
--   Client     — ≥1 Closed Won engagement (won → customer, outranks the
--                nurture funnel; the bug this fixes: won clients with a
--                NULL paid_amount roll-up read as Nurturing)
--   Past       — paid history (paid_amount > 0) without a won engagement
--   Attempting — human reach_out touchpoint in the last 30 days
--   New        — created in the last 30 days
--   Nurturing  — everyone else (the marketable pool)
--
-- Scope: ALL locations (the bug is global), excluding is_junk rows (they
-- live in the Recycle Bin; the app never derives a status for them, so
-- storing one would be misleading — they stay NULL).
--
-- Staleness caveat: Attempting/New are time-relative and Active/Client
-- change as engagements move — stored values are a SNAPSHOT at run time.
-- The live derivation stays authoritative; re-run this whenever the
-- stored column needs to be trued up (it is idempotent).
--
-- Projected breakdown (prod read 2026-07-10 late, post-4dc7478 repair,
-- 2,243 in-scope of 2,283):
--   Client 843 · Nurturing 1,322 · Active 75 · New 1 · no_contact 2 ·
--   Past 0 · Attempting 0 — per location Client: Portland 546 /
--   Palm Beach 206 / NW Arkansas 91. (Earlier stale projections: 697
--   Client on 7/9 pre-requestless-backfill; 779 Client / 63 Past on
--   7/10 pre-repair — the 63 Past were misfounded stale-Lost wins.)
--   Live-app activity between projection and run may shift a count by
--   ±1-2; the UPDATE derives at run time, so stored == derived always.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS client_status text;

COMMENT ON COLUMN leads.client_status IS
  'Stored snapshot of the people-side status (see components/hive/shared/clientStatus.js — the live derivation is authoritative and does not read this). Vocabulary: New | Attempting | Nurturing | Active | Client | Past | no_contact.';

-- ── Dry run: preview the breakdown without writing ──────────────────
-- (Same CASE as the UPDATE below; run this first, compare to projection.)
SELECT derived AS client_status, COUNT(*) AS rows
FROM (
  SELECT CASE
    WHEN COALESCE(BTRIM(l.email), '') = '' AND COALESCE(BTRIM(l.phone), '') = ''
      THEN 'no_contact'
    WHEN EXISTS (SELECT 1 FROM engagements e
                 WHERE e.client_id = l.id
                   AND e.stage NOT IN ('Closed Won', 'Closed Lost'))
      THEN 'Active'
    WHEN EXISTS (SELECT 1 FROM engagements e
                 WHERE e.client_id = l.id AND e.stage = 'Closed Won')
      THEN 'Client'
    WHEN COALESCE(l.paid_amount, 0) > 0
      THEN 'Past'
    WHEN EXISTS (SELECT 1 FROM touchpoints t
                 WHERE t.lead_id = l.id
                   AND t.kind = 'reach_out'
                   AND t.occurred_at > now() - interval '30 days')
      THEN 'Attempting'
    WHEN l.created_at > now() - interval '30 days'
      THEN 'New'
    ELSE 'Nurturing'
  END AS derived
  FROM leads l
  WHERE l.is_junk IS NOT TRUE
) d
GROUP BY derived
ORDER BY rows DESC;

-- ── The backfill ─────────────────────────────────────────────────────
UPDATE leads l
SET client_status = CASE
  WHEN COALESCE(BTRIM(l.email), '') = '' AND COALESCE(BTRIM(l.phone), '') = ''
    THEN 'no_contact'
  WHEN EXISTS (SELECT 1 FROM engagements e
               WHERE e.client_id = l.id
                 AND e.stage NOT IN ('Closed Won', 'Closed Lost'))
    THEN 'Active'
  WHEN EXISTS (SELECT 1 FROM engagements e
               WHERE e.client_id = l.id AND e.stage = 'Closed Won')
    THEN 'Client'
  WHEN COALESCE(l.paid_amount, 0) > 0
    THEN 'Past'
  WHEN EXISTS (SELECT 1 FROM touchpoints t
               WHERE t.lead_id = l.id
                 AND t.kind = 'reach_out'
                 AND t.occurred_at > now() - interval '30 days')
    THEN 'Attempting'
  WHEN l.created_at > now() - interval '30 days'
    THEN 'New'
  ELSE 'Nurturing'
END
WHERE l.is_junk IS NOT TRUE;

-- ── Verify after running ─────────────────────────────────────────────
-- SELECT client_status, COUNT(*) FROM leads
-- WHERE is_junk IS NOT TRUE GROUP BY 1 ORDER BY 2 DESC;
-- Expect ~843 'Client' rows and zero won clients under 'Nurturing':
-- SELECT COUNT(*) FROM leads l
-- WHERE l.client_status = 'Nurturing'
--   AND EXISTS (SELECT 1 FROM engagements e
--               WHERE e.client_id = l.id AND e.stage = 'Closed Won');
-- → must be 0.
