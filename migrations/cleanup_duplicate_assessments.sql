-- One-time cleanup: delete duplicate assessment rows, keeping the
-- EARLIEST row per service_request_id.
--
-- Cause: upsertAssessment's check-then-insert raced under Jobber
-- webhook bursts, and with no unique index on assessments the dupes
-- landed; the discarded .maybeSingle() error (PGRST116 on multiple
-- rows) then made every later sync insert ANOTHER row (snowball).
-- Scanned 7/9/26: 1,098 assessment rows, exactly one affected
-- service_request_id (Chelsea Atkins, 8 rows → 7 deleted). Written
-- generally in case another lands before this runs.
--
-- Dupes are identical except jobber_synced_at (verified 7/9/26:
-- same engagement_id/status/scheduled_at across all 8), so nothing
-- references the deleted ids. No table carries an assessment_id FK.
--
-- MUST run BEFORE migrations/assessments_service_request_unique.sql
-- (the unique index refuses to build over existing dupes).

-- ─── PRE-FLIGHT: preview what would be deleted ──────────────────────
-- SELECT service_request_id, count(*)
--   FROM assessments
--   WHERE service_request_id IS NOT NULL
--   GROUP BY 1 HAVING count(*) > 1;
-- Expected: 1 row — fe825918-ae54-4393-872b-2ea34c7868fb, count 8.

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY service_request_id
           ORDER BY created_at ASC, jobber_synced_at ASC NULLS LAST, id ASC
         ) AS rn
  FROM assessments
  WHERE service_request_id IS NOT NULL
)
DELETE FROM assessments
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
-- Expected: DELETE 7
