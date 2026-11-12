-- migrations/slack_scopes.sql
--
-- WHAT EACH SLACK INSTALL GRANTED (2026-11-04, job channels slice 1).
-- The comma-separated bot-scope string Slack's oauth.v2.access returns,
-- stored on every connect by app/api/slack/callback/route.ts.
--
-- Every location connected before this runs keeps NULL. NULL means UNKNOWN
-- and is read as "old scopes" (lib/slack-scopes.ts slackCanManageChannels):
-- no backfill, no guess. A location proves it has channels:manage by
-- reconnecting.
--
-- The app works before this runs: the callback drops the column and writes
-- the rest, and the screen reads every location as not-ready.
--
-- Adds one empty column. Single statement, safe to re-run. Touches no row.
alter table public.locations
  add column if not exists slack_scopes text;
