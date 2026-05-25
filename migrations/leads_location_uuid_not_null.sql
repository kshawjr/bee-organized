-- migrations/leads_location_uuid_not_null.sql
--
-- Locks in leads.location_uuid as required. The column was added by
-- hive_clients_phase0.sql (2026-05-19) with a backfill from the legacy
-- location_id slug, but stayed nullable so an in-flight bad insert
-- wouldn't fail the migration.
--
-- Pre-flight check (2026-05-25): zero rows had NULL location_uuid. The
-- only known write path that didn't populate it was the public X-API-Key
-- intake webhook (app/api/leads/intake/route.ts), fixed in the same
-- commit as this migration.
--
-- Re-runnable: SET NOT NULL is a no-op if the constraint is already in
-- place.

ALTER TABLE leads ALTER COLUMN location_uuid SET NOT NULL;
