-- ════════════════════════════════════════════════════════════════════════════
-- TEMPLATES REWORK — master + location-custom split
-- ════════════════════════════════════════════════════════════════════════════
--
-- Renames master_templates → templates. One table now holds both corp-owned
-- masters (location_uuid IS NULL) and location-owned customs
-- (location_uuid = the owning location). Masters remain live references —
-- corp edits a master and every drip step pointing at it renders with the
-- new content on the next cron run. Customs are independent: created by
-- duplicating a master (cloned_from_id tracks the source) or from scratch.
--
-- ────────────────────────────────────────────────────────────────────────────
-- HOW TO RUN
-- ────────────────────────────────────────────────────────────────────────────
-- Paste this whole file into the Supabase SQL editor and run it. It is
-- idempotent — re-running is safe.
--
-- DEPLOY ORDER (important):
--   1. Run this migration first (renames table, adds columns).
--   2. Immediately deploy the matching code (vercel --prod / git push to main).
--      Between (1) and (2) any in-flight cron run that hits master_templates
--      will 500; it will retry next hour.
--
-- ────────────────────────────────────────────────────────────────────────────
-- PRE-FLIGHT CHECKS (read-only)
-- ────────────────────────────────────────────────────────────────────────────
--   SELECT to_regclass('public.master_templates') IS NOT NULL AS old_exists;
--   SELECT to_regclass('public.templates')         IS NOT NULL AS new_exists;
--   -- Expect old_exists = t before first run, f after.
--   -- Expect new_exists = f before first run, t after.
--
-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual)
-- ────────────────────────────────────────────────────────────────────────────
--   -- Drop customs first (they reference masters via cloned_from_id, and
--   -- locations via location_uuid).
--   DELETE FROM templates WHERE location_uuid IS NOT NULL;
--   ALTER TABLE templates DROP COLUMN IF EXISTS created_by;
--   ALTER TABLE templates DROP COLUMN IF EXISTS cloned_from_id;
--   ALTER TABLE templates DROP COLUMN IF EXISTS location_uuid;
--   DROP INDEX IF EXISTS idx_templates_location;
--   ALTER INDEX idx_templates_type   RENAME TO idx_master_templates_type;
--   ALTER INDEX idx_templates_tag    RENAME TO idx_master_templates_tag;
--   ALTER INDEX idx_templates_active RENAME TO idx_master_templates_active;
--   ALTER TRIGGER trg_templates_updated_at ON templates
--     RENAME TO trg_master_templates_updated_at;
--   ALTER TABLE templates RENAME TO master_templates;
-- ════════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Rename master_templates → templates
-- ──────────────────────────────────────────────────────────────────────────
-- Idempotent: only renames if the old name still exists.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'master_templates'
  ) THEN
    EXECUTE 'ALTER TABLE master_templates RENAME TO templates';
  END IF;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 2 — Rename indexes + trigger to match the new table name
-- ──────────────────────────────────────────────────────────────────────────
-- Postgres does not auto-rename indexes / triggers when a table is renamed,
-- but the FK constraint on drip_path_steps.master_template_id retargets
-- automatically (constraint name is unchanged, just points at the renamed
-- table now).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_master_templates_type') THEN
    EXECUTE 'ALTER INDEX idx_master_templates_type RENAME TO idx_templates_type';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_master_templates_tag') THEN
    EXECUTE 'ALTER INDEX idx_master_templates_tag RENAME TO idx_templates_tag';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_master_templates_active') THEN
    EXECUTE 'ALTER INDEX idx_master_templates_active RENAME TO idx_templates_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_master_templates_updated_at'
  ) THEN
    EXECUTE 'ALTER TRIGGER trg_master_templates_updated_at ON templates RENAME TO trg_templates_updated_at';
  END IF;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 3 — New columns: location_uuid, cloned_from_id, created_by
-- ──────────────────────────────────────────────────────────────────────────
-- location_uuid IS NULL  → master template (corp-owned, lives reference)
-- location_uuid IS NOT NULL → location custom (owner-owned, independent copy)

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS location_uuid uuid
  REFERENCES locations(id) ON DELETE CASCADE;

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS cloned_from_id uuid
  REFERENCES templates(id) ON DELETE SET NULL;

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS created_by uuid
  REFERENCES hub_users(id) ON DELETE SET NULL;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 4 — Index for owner lookups
-- ──────────────────────────────────────────────────────────────────────────
-- Owners hit "give me my location's customs" via location_uuid; the partial
-- predicate keeps the index small (only customs are indexed, not the
-- ~17 masters).

CREATE INDEX IF NOT EXISTS idx_templates_location
  ON templates(location_uuid)
  WHERE location_uuid IS NOT NULL;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 5 — Verify FK constraint on drip_path_steps still points at templates
-- ──────────────────────────────────────────────────────────────────────────
-- Postgres retargets FKs automatically on table rename, but we check
-- defensively and raise if something is off. The column name stays as
-- master_template_id (renaming it would force a much larger code change
-- for marginal cleanup benefit).

DO $$
DECLARE
  fk_target text;
BEGIN
  SELECT confrelid::regclass::text INTO fk_target
  FROM pg_constraint
  WHERE conrelid = 'drip_path_steps'::regclass
    AND contype = 'f'
    AND conkey @> ARRAY[
      (SELECT attnum FROM pg_attribute
       WHERE attrelid = 'drip_path_steps'::regclass
         AND attname = 'master_template_id')
    ];

  IF fk_target IS NULL THEN
    RAISE EXCEPTION 'drip_path_steps.master_template_id has no FK constraint';
  END IF;
  IF fk_target <> 'templates' THEN
    RAISE EXCEPTION 'drip_path_steps.master_template_id FK points at % (expected templates)', fk_target;
  END IF;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- POST-RUN VERIFICATION (read-only)
-- ──────────────────────────────────────────────────────────────────────────
--   -- Expect 17 masters (location_uuid NULL):
--   SELECT count(*) FROM templates WHERE location_uuid IS NULL;
--
--   -- Expect 0 customs initially:
--   SELECT count(*) FROM templates WHERE location_uuid IS NOT NULL;
--
--   -- Confirm FK on drip_path_steps:
--   SELECT conname, confrelid::regclass FROM pg_constraint
--   WHERE conrelid = 'drip_path_steps'::regclass AND contype = 'f';
--
--   -- Confirm renamed indexes:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'templates';
