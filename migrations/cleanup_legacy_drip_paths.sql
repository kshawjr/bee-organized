-- ════════════════════════════════════════════════════════════════════════════
-- CLEANUP LEGACY DRIP_PATHS
-- ════════════════════════════════════════════════════════════════════════════
--
-- Wipes the 22 bootstrap drip_paths rows seeded by drips_infrastructure.sql
-- (each launch location got its own copy of general-a + move-a). No content
-- loss — these were placeholder bodies referencing master_templates that
-- pre-dated this rework.
--
-- After this migration, drip_paths is empty. seed_master_drip_paths.sql
-- (next) inserts 8 corp masters. Locations re-pick during onboarding;
-- the existing seedDefaultDripPaths() helper in lib/drip-lifecycle.ts is
-- updated in commit 2 to clone from masters.
--
-- Also nulls out locations.default_drip_path and default_move_drip_path
-- (per Kevin: force every owner to re-pick during onboarding) — the
-- previous values 'general-a' / 'move-a' would otherwise be orphans
-- pointing at deleted path_keys.
--
-- Idempotent: re-running is safe (subsequent runs are no-ops).
--
-- DEPLOY ORDER:
--   1. drip_paths_is_master.sql (prerequisite — needs the relaxed schema)
--   2. THIS file
--   3. seed_master_drip_paths.sql
-- ════════════════════════════════════════════════════════════════════════════


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Sanity check (skippable)
-- ──────────────────────────────────────────────────────────────────────────
-- Refuses to run if any drip has actually sent (lead_drip_progress.last_sent_at
-- is non-null). This is a guardrail for *future* re-runs once the system is
-- live; for the initial deploy on a clean Test Location, prepend this line
-- to your SQL editor session BEFORE running:
--
--     SET LOCAL app.bypass_drip_cleanup = 'true';
--
-- which makes the block a no-op.

DO $$
DECLARE
  active_count int;
  bypass       text;
BEGIN
  bypass := current_setting('app.bypass_drip_cleanup', true);
  IF bypass = 'true' THEN
    RAISE NOTICE 'cleanup_legacy_drip_paths: guardrail bypassed via app.bypass_drip_cleanup';
    RETURN;
  END IF;

  SELECT count(*) INTO active_count
  FROM lead_drip_progress
  WHERE last_sent_at IS NOT NULL;

  IF active_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to cleanup drip_paths: % lead_drip_progress rows have last_sent_at set (actual sends in flight). To bypass: SET LOCAL app.bypass_drip_cleanup = ''true''',
      active_count;
  END IF;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 2 — Delete drip_path_steps (orphan-safe even without CASCADE)
-- ──────────────────────────────────────────────────────────────────────────
DELETE FROM drip_path_steps
WHERE drip_path_id IN (SELECT id FROM drip_paths);


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 3 — Delete lead_drip_progress (any pre-launch test rows)
-- ──────────────────────────────────────────────────────────────────────────
-- lead_drip_progress.drip_path_id FK is ON DELETE CASCADE so this would
-- happen automatically; doing it explicitly to make the intent visible.

DELETE FROM lead_drip_progress;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 4 — Delete drip_paths (all 22 bootstrap rows)
-- ──────────────────────────────────────────────────────────────────────────
DELETE FROM drip_paths;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 5 — Null out location default drip path pointers
-- ──────────────────────────────────────────────────────────────────────────
-- These columns previously defaulted to 'general-a' / 'move-a' (now
-- deleted). Setting to NULL forces every owner to re-pick during
-- onboarding, which is intentional — owners should see the new
-- A/B/C/D options and make a fresh choice.

UPDATE locations
SET default_drip_path = NULL,
    default_move_drip_path = NULL
WHERE default_drip_path IS NOT NULL
   OR default_move_drip_path IS NOT NULL;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 6 — Drop the old DEFAULT on those columns
-- ──────────────────────────────────────────────────────────────────────────
-- onboarding_persistence.sql set default 'general-a' / 'move-a' as
-- column defaults. New locations inserted from now on should default
-- to NULL — owners pick during onboarding.

ALTER TABLE locations ALTER COLUMN default_drip_path      DROP DEFAULT;
ALTER TABLE locations ALTER COLUMN default_move_drip_path DROP DEFAULT;


COMMIT;


-- POST-RUN VERIFICATION
--   -- Expect 0:
--   SELECT count(*) AS drip_paths_remaining FROM drip_paths;
--   SELECT count(*) AS drip_path_steps_remaining FROM drip_path_steps;
--
--   -- Expect 0 non-null defaults across all locations:
--   SELECT count(*) FROM locations
--     WHERE default_drip_path IS NOT NULL
--        OR default_move_drip_path IS NOT NULL;
--
--   -- Confirm column defaults are gone:
--   SELECT column_name, column_default FROM information_schema.columns
--     WHERE table_name = 'locations'
--       AND column_name IN ('default_drip_path', 'default_move_drip_path');
