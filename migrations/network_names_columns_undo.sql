-- UNDO for migrations/network_names_columns.sql. Removes the three columns
-- and whatever they hold. Run network_names_backfill_undo.sql first only if
-- you want to keep the columns; this one alone is a full undo.
alter table public.partners
  drop column if exists first_name,
  drop column if exists last_name;

alter table public.locations
  drop column if exists network_import_mappings;
