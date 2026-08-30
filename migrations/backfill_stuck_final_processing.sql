-- migrations/backfill_stuck_final_processing.sql
--
-- ═══ HELD DATA ARTIFACT — OPTIONAL — KEVIN RUNS OR SKIPS ═══
--
-- This is NOT a schema migration and NOT required by the code change. The
-- deployed fix (the Mark-won gate accepting settled-or-zero invoices)
-- already makes every stuck engagement closeable by its OWNER through the
-- close-won wizard — which also records satisfaction/review flags and
-- schedules the re-engage marker, none of which this SQL does.
--
-- Run this ONLY if you would rather bulk-close the stranded backlog than
-- wait for owners to click through their own. THE HONEST CAVEAT, stated
-- once more: an archived job with no invoice is USUALLY completed free /
-- settled-outside work (the volunteer case), but the data cannot
-- distinguish that from work that was agreed and quietly abandoned —
-- completed_at is stamped on every archived import row, so it proves
-- nothing. This artifact labels them all Closed Won at $0. Any that were
-- really abandoned end up wearing Won. Owners closing their own through
-- the wizard is the accurate path; this is the fast one.
--
-- Scope: engagements at Final Processing whose jobs are ALL done (archived
-- or completed) and which have ZERO invoices — the exact bucket the broken
-- gate stranded. 160 rows on 2026-08-30 (Kansas City 34, Portland 28,
-- Rhode Island 19, Seattle/Scottsdale/Carmel 11 each, …). Engagements with
-- any invoice (paid or owing) are NOT touched; nor is anything at any
-- other stage.

-- ─── 1. DRY RUN FIRST — count and eyeball ────────────────────────────
--
-- SELECT e.id, l.name AS location, e.title, e.stage_entered_at::date
-- FROM engagements e
-- LEFT JOIN locations l ON l.id = e.location_uuid
-- WHERE e.stage = 'Final Processing'
--   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.engagement_id = e.id)
--   AND EXISTS (SELECT 1 FROM jobs j WHERE j.engagement_id = e.id)
--   AND NOT EXISTS (
--     SELECT 1 FROM jobs j WHERE j.engagement_id = e.id
--       AND j.completed_at IS NULL AND j.status NOT ILIKE '%complet%'
--   )
-- ORDER BY l.name;
-- -- expect ~160 rows (2026-08-30 count; will drift as owners close some)

-- ─── 2. THE CLOSE ────────────────────────────────────────────────────

BEGIN;

UPDATE engagements e SET
  stage = 'Closed Won',
  closed_reason = 'job_archived_settled',
  closed_at = now(),
  stage_entered_at = now(),
  closed_note = 'Closed in bulk: every job finished or archived in Jobber with nothing invoiced ($0). If this deal was actually lost, reopen it and close it properly.',
  total_invoiced = 0,
  total_paid = 0,
  balance_owing = 0,
  updated_at = now()
WHERE e.stage = 'Final Processing'
  AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.engagement_id = e.id)
  AND EXISTS (SELECT 1 FROM jobs j WHERE j.engagement_id = e.id)
  AND NOT EXISTS (
    SELECT 1 FROM jobs j WHERE j.engagement_id = e.id
      AND j.completed_at IS NULL AND j.status NOT ILIKE '%complet%'
  );
-- expect: UPDATE ~160

COMMIT;

-- ─── 3. VERIFY ───────────────────────────────────────────────────────
--
-- SELECT closed_reason, count(*) FROM engagements
-- WHERE closed_reason = 'job_archived_settled' GROUP BY 1;
--
-- SELECT count(*) FROM engagements e
-- WHERE e.stage = 'Final Processing'
--   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.engagement_id = e.id)
--   AND EXISTS (SELECT 1 FROM jobs j WHERE j.engagement_id = e.id)
--   AND NOT EXISTS (
--     SELECT 1 FROM jobs j WHERE j.engagement_id = e.id
--       AND j.completed_at IS NULL AND j.status NOT ILIKE '%complet%'
--   );
-- -- expect: 0
--
-- Money claims: total_invoiced/total_paid/balance_owing are set to 0 —
-- no revenue is invented anywhere. Reopen (Closed Lost only) does not
-- apply to Won rows; a mis-bulked row is corrected by hand, which is why
-- the wizard path is the recommended one.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────
-- Rows are identifiable by closed_reason:
--   UPDATE engagements SET stage='Final Processing', closed_reason=NULL,
--     closed_at=NULL, closed_note=NULL, stage_entered_at=now(), updated_at=now()
--   WHERE closed_reason = 'job_archived_settled';
