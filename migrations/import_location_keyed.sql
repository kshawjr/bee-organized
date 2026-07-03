-- Rework the resumable Jobber import to be LOCATION-keyed, not job-keyed:
--   * staged nodes dedupe across ALL jobs for a location, so a fresh job
--     reuses the prior job's staged rows instead of restarting the fetch.
--   * fetch cursors + completion flags live in their own table, keyed by
--     location, so a re-run inherits the prior fetch progress.
--   * a partial UNIQUE index enforces at most one running import_jobs row
--     per location, and a compare-and-swap on location_claim_at serialises
--     concurrent POSTs so only one caller drives the next segment.
-- Backfill is done in-place: any existing staging rows get their location_id
-- populated from their job's location before the NOT NULL is enforced.

-- ── Fix A: staging keyed by location ──────────────────────────────
ALTER TABLE import_staging
  ADD COLUMN IF NOT EXISTS location_id text;

UPDATE import_staging s
   SET location_id = j.location_id
  FROM import_jobs j
 WHERE s.job_id = j.id
   AND s.location_id IS NULL;

ALTER TABLE import_staging
  ALTER COLUMN location_id SET NOT NULL;

-- Re-key dedup uniqueness to (location_id, entity, node_id). Old per-job
-- index would let two jobs for the same location double-stage the same node.
DROP INDEX IF EXISTS idx_import_staging_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_staging_dedup_loc
  ON import_staging(location_id, entity, node_id);
CREATE INDEX IF NOT EXISTS idx_import_staging_loc_entity
  ON import_staging(location_id, entity);

-- ── Fix A: per-location fetch state ───────────────────────────────
-- Replaces import_jobs.fetch_cursors / fetch_complete for the fetch phase.
-- Kept as a separate table so a fresh import_jobs row inherits progress.
CREATE TABLE IF NOT EXISTS import_location_fetch (
  location_id     text PRIMARY KEY,
  fetch_cursors   jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetch_complete  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz DEFAULT now()
);

-- ── Backfill fetch_complete from prior jobs (Portland etc.) ────────
-- Locations that already have fully-staged entities from failed jobs must
-- NOT re-fetch from Jobber. Merge every prior job's fetch_complete into a
-- per-location row, OR-ing across jobs (any job that hit hasNextPage=false
-- for an entity fully staged it). fetch_cursors is intentionally NOT copied:
-- with fetch_complete=true the new code short-circuits before consulting
-- cursors, and partial-progress cursors on incomplete entities would point
-- into a resume window that may not match current staging. Safer to let
-- incomplete entities re-fetch from scratch. COALESCE guards against a
-- degenerate group producing NULL (fetch_complete is NOT NULL).
INSERT INTO import_location_fetch (location_id, fetch_complete)
SELECT
  j.location_id,
  COALESCE(jsonb_object_agg(k.key, true), '{}'::jsonb)
FROM import_jobs j,
     LATERAL jsonb_each_text(COALESCE(j.fetch_complete, '{}'::jsonb)) k
WHERE k.value = 'true'
GROUP BY j.location_id
ON CONFLICT (location_id) DO UPDATE
  SET fetch_complete = import_location_fetch.fetch_complete || EXCLUDED.fetch_complete,
      updated_at     = now();

-- ── Fix B: atomic location-level claim + one-running-per-location ─
ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS location_claim_at timestamptz;

-- Query index for "find the running job for this location".
CREATE INDEX IF NOT EXISTS idx_import_jobs_loc_running
  ON import_jobs(location_id, status)
  WHERE status = 'running';

-- ── Cleanup: dedupe running jobs so idx_import_jobs_one_running builds ─
-- The partial UNIQUE index below refuses to build against a table state
-- with more than one status='running' row per location. Portland (and any
-- other location hit by the pre-atomic-claim POST race) currently has
-- duplicates. Keep the most-recent running row per location, close the
-- older duplicates as 'failed' with an audit message. RAISE NOTICE prints
-- the count so the operator running this in the SQL editor sees the impact.
-- Using 'failed' (not 'superseded') because 'failed' is already a known
-- valid status per route.ts's own writes.
DO $$
DECLARE
  closed_count int;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY location_id ORDER BY started_at DESC) AS rn
    FROM import_jobs
    WHERE status = 'running'
  ),
  updated AS (
    UPDATE import_jobs
       SET status        = 'failed',
           completed_at  = COALESCE(completed_at, now()),
           error_message = COALESCE(error_message, 'auto-closed: duplicate running row before location-keyed migration')
     WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING id
  )
  SELECT COUNT(*) INTO closed_count FROM updated;
  RAISE NOTICE 'Closed % duplicate running import_jobs rows to allow partial unique index', closed_count;
END $$;

-- Enforcement index: at most one running job per location. Two concurrent
-- POSTs that both miss the SELECT and both try to INSERT will race here;
-- the loser hits 23505 and the route falls back to SELECT-then-claim.
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_jobs_one_running
  ON import_jobs(location_id)
  WHERE status = 'running';
