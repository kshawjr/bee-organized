-- migrations/zip_coords_undo.sql
--
-- Undoes migrations/zip_coords.sql: drops the zip_coords table and every row
-- in it. Safe at any time. It is public Census reference data, not customer
-- data, and scripts/load-zip-coords.mjs --commit reloads it.
--
-- While the table is gone, lib/zip-proximity.ts nearestLocationsForZip throws
-- "zip_coords read failed" rather than suggesting a location from no map.

DROP TABLE IF EXISTS public.zip_coords;
