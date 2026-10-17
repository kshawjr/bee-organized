-- migrations/assessment_type.sql
--
-- PURPOSE
--   In-person vs virtual assessments, kept by us for the first time.
--     1. locations.default_assessment_type — the location's default, set in
--        Settings › Location › Assessment Default. The Send to Jobber screen
--        starts on it (the client's own last type wins over it).
--     2. assessments.assessment_type — the type chosen when Bee Hub sent the
--        assessment to Jobber. NULL means "not recorded": every assessment
--        made in Jobber directly, and every one sent before this shipped.
--        The Jobber import/webhook never writes this column (it is not in
--        upsertAssessment's payload — pinned in lib/assessment-type.test.ts),
--        so a re-sync can't wipe it.
--
--   Both columns are additive and nullable/defaulted: nothing existing
--   changes value. locations rows read 'in-person', exactly what the send
--   screen already started on.
--
-- ORDER. The code tolerates this not having run: pages read both columns in
-- separate error-tolerant selects (missing column → 'in-person'), the send
-- still lands in Jobber and only logs the failed type record, and saving the
-- Settings default answers 503 "not enabled yet". Run it before telling
-- owners the default saves.
--
-- HOW TO UNDO
--   migrations/assessment_type_undo.sql — drops both columns (and with them
--   every recorded type and every location's default).

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS default_assessment_type text NOT NULL DEFAULT 'in-person';

ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS assessment_type text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_default_assessment_type_check') THEN
    ALTER TABLE locations
      ADD CONSTRAINT locations_default_assessment_type_check
      CHECK (default_assessment_type IN ('in-person', 'virtual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessments_assessment_type_check') THEN
    ALTER TABLE assessments
      ADD CONSTRAINT assessments_assessment_type_check
      CHECK (assessment_type IS NULL OR assessment_type IN ('in-person', 'virtual'));
  END IF;
END $$;

-- Report: every location reads 'in-person', no assessment has a type yet.
SELECT
  (SELECT count(*) FROM locations)                                             AS locations_rows,
  (SELECT count(*) FROM locations WHERE default_assessment_type = 'in-person') AS locations_in_person,
  (SELECT count(*) FROM assessments)                                           AS assessments_rows,
  (SELECT count(*) FROM assessments WHERE assessment_type IS NOT NULL)         AS assessments_with_type;
