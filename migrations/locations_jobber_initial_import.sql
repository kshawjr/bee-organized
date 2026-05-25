-- migrations/locations_jobber_initial_import.sql
--
-- Track whether a location has completed its first Jobber bulk import.
-- Set by /api/import/jobber-clients when the import finishes (even if some
-- rows errored — two-way sync via webhooks heals missed records).
--
-- Used by Settings → Locations to hide the manual "Import from Jobber" button
-- after a successful first run, preventing duplicate work once the ongoing
-- webhook sync is live.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS jobber_initial_import_completed_at timestamptz;
