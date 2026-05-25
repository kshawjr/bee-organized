-- ════════════════════════════════════════════════════════════════════════════
-- LOCATIONS — rate_per_hour
-- ════════════════════════════════════════════════════════════════════════════
--
-- Adds locations.rate_per_hour (text, nullable). The value is rendered into
-- drip emails as the {{rate_per_hour}} variable — e.g. "$95" or
-- "$85 (3-hour minimum)". Free-form text rather than numeric because
-- presentation varies by location (currency symbol, suffix, etc.).
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS rate_per_hour text;

-- POST-RUN VERIFICATION
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'locations' AND column_name = 'rate_per_hour';
