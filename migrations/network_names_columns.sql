-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/network_names_columns.sql — Network slice 5, third follow-up
-- STEP 1 OF 2: three new empty columns. Nothing is dropped or renamed.
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN. Kevin runs it, then network_names_backfill.sql.
-- Safe to run twice (if not exists).
--
-- partners.first_name, partners.last_name
--   A Network contact's first and last name, the same two columns Clients
--   (leads) has. `name` stays and keeps holding the full name; the app sets
--   it from first + last the way Clients does (lib/lead-name.ts,
--   composeLeadName). Both start blank on every row. An organization keeps
--   them blank: its name is `name` alone.
--
-- locations.network_import_mappings
--   The import screen's remembered column choices, per location, so the
--   second file from the same source arrives already mapped. Kevin's ruling
--   2026-11-19: a column on locations, in this same one migration. JSON, an
--   empty object to start. Holds column names only, never contact data.
--
-- No trigger, no index, no check, no data moved. Rows are not touched.
-- UNDO: migrations/network_names_columns_undo.sql
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.partners
  add column if not exists first_name text,
  add column if not exists last_name text;

alter table public.locations
  add column if not exists network_import_mappings jsonb not null default '{}'::jsonb;
