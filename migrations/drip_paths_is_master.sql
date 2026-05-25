-- ════════════════════════════════════════════════════════════════════════════
-- DRIP_PATHS — is_master + nullable location_uuid
-- ════════════════════════════════════════════════════════════════════════════
--
-- Adds the master-vs-location-copy distinction to drip_paths:
--   - is_master = true  AND location_uuid IS NULL     → corp-owned master
--   - is_master = false AND location_uuid IS NOT NULL → location copy
--
-- Schema changes:
--   1. drip_paths.location_uuid → DROP NOT NULL (masters have NULL)
--   2. drip_paths.is_master boolean NOT NULL DEFAULT false
--   3. CHECK constraint enforcing the (is_master, location_uuid) pairing
--   4. Partial unique index — only one master per path_key
--   5. Adds cloned_from_id (uuid, FK → drip_paths) to track which master a
--      location copy was cloned from. NULL for masters and for legacy
--      from-scratch customs.
--
-- Idempotent.
--
-- DEPLOY ORDER:
--   1. Run this migration first.
--   2. Run cleanup_legacy_drip_paths.sql (wipes the 22 bootstrap rows).
--   3. Run seed_master_drip_paths.sql (inserts the 8 masters + steps + the
--      7 standalone master templates).
--   4. Deploy code that knows how to render masters / let owners clone.
-- ════════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Drop NOT NULL on location_uuid
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE drip_paths ALTER COLUMN location_uuid DROP NOT NULL;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 2 — is_master column
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE drip_paths
  ADD COLUMN IF NOT EXISTS is_master boolean NOT NULL DEFAULT false;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 3 — cloned_from_id
-- ──────────────────────────────────────────────────────────────────────────
-- When an owner clicks "Customize" on a master path, we INSERT a new
-- drip_paths row with is_master=false, location_uuid=<loc>, and
-- cloned_from_id pointing at the master. Useful for "Reset to master"
-- and for analytics ("how many locations have customized Path B?").

ALTER TABLE drip_paths
  ADD COLUMN IF NOT EXISTS cloned_from_id uuid
  REFERENCES drip_paths(id) ON DELETE SET NULL;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 4 — CHECK constraint: (is_master, location_uuid) pairing
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE drip_paths DROP CONSTRAINT IF EXISTS drip_paths_master_xor_location;
ALTER TABLE drip_paths
  ADD CONSTRAINT drip_paths_master_xor_location
  CHECK (
    (is_master = true  AND location_uuid IS NULL) OR
    (is_master = false AND location_uuid IS NOT NULL)
  );


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 5 — Partial unique index: one master per path_key
-- ──────────────────────────────────────────────────────────────────────────
-- Postgres treats NULL location_uuid as distinct in the existing
-- UNIQUE(location_uuid, path_key, name) constraint, which would let two
-- masters share a path_key. The partial unique index plugs that gap.

CREATE UNIQUE INDEX IF NOT EXISTS idx_drip_paths_master_path_key_uniq
  ON drip_paths(path_key)
  WHERE is_master = true;


-- POST-RUN VERIFICATION
--   -- Expect is_master column exists, default false:
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'drip_paths' AND column_name = 'is_master';
--
--   -- Expect 0 masters before seed:
--   SELECT count(*) FROM drip_paths WHERE is_master = true;
