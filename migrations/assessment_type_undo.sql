-- migrations/assessment_type_undo.sql
--
-- Reverses migrations/assessment_type.sql. Drops both columns, which throws
-- away every recorded in-person/virtual type and every location's default.
-- Roll the code back FIRST: the send route writes assessments.assessment_type
-- and Settings reads locations.default_assessment_type — with the columns gone
-- those calls error (the send itself still lands in Jobber; only the local
-- record of the type fails, and it is logged).

ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_assessment_type_check;
ALTER TABLE assessments DROP COLUMN IF EXISTS assessment_type;

ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_default_assessment_type_check;
ALTER TABLE locations DROP COLUMN IF EXISTS default_assessment_type;

SELECT count(*) AS columns_left
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'locations'   AND column_name = 'default_assessment_type')
    OR (table_name = 'assessments' AND column_name = 'assessment_type'));
