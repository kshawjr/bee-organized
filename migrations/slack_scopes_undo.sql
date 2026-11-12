-- migrations/slack_scopes_undo.sql
-- Undo for slack_scopes.sql. Drops the recorded grants: every location then
-- reads as not-ready again until it reconnects after a re-run.
alter table public.locations
  drop column if exists slack_scopes;
