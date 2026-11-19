-- UNDO for migrations/network_names_backfill.sql: blanks first and last name
-- on every contact again. `name` was never changed, so nothing else is needed.
-- Note: this also blanks first/last typed by owners after the backfill ran.
update public.partners set first_name = null, last_name = null
where first_name is not null or last_name is not null;
