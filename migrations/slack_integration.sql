-- ═══════════════════════════════════════════════════════════════════════════
-- Slack lead-notification integration — per-location bot-token storage.
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Idempotent: every column
-- uses ADD COLUMN IF NOT EXISTS, safe to re-run.
--
-- MODEL. Each location has its own Slack workspace. The Bee Hub Slack app
-- (owned by admin@beeorganized.com) is installed per-workspace via the
-- "Add to Slack" OAuth v2 flow, yielding a per-location BOT token that is
-- stored here and used to chat.postMessage a new-lead notification into the
-- location's chosen channel — IN ADDITION to the existing email. Slack is
-- purely additive: a Slack failure never blocks or breaks the email send or
-- the lead-row write.
--
-- NO REFRESH / EXPIRY COLUMNS. Token rotation is left OFF on the Slack app, so
-- bot tokens do NOT expire — unlike Jobber (jobber_refresh_token / token_expiry).
-- The only way a connection dies is an uninstall on the Slack side, surfaced at
-- send time via an invalid_auth error, not proactively via a clock. So there is
-- deliberately no slack_refresh_token / slack_token_expiry here.
--
-- SECURITY. slack_bot_token is SERVER-READ-ONLY — read via the service-role
-- client in lib/slack-bot.ts + the intake route, and NEVER selected into any
-- browser-facing payload. The client is threaded only the display fields
-- (slack_connected / slack_team_name / slack_channel_name). See _hub-page.tsx
-- select lists, which intentionally omit slack_bot_token.
--
-- location_id TYPE — these are COLUMNS on the existing public.locations table
-- (PK id uuid). All token writes are PK-keyed (.eq('id', <uuid>)), mirroring
-- the Jobber OAuth callback + disconnect. No new table, no new RLS: the columns
-- inherit locations' existing row-level security. Do NOT add a slug-vs-uuid RLS
-- policy on these fields (locations.location_id is TEXT; a UUID comparison would
-- need a ::text cast and is unnecessary here).
--
-- SEPARATE FROM THE OLD DIGEST. This is unrelated to SLACK_WEBHOOK_URL /
-- lib/slack.ts (the twice-daily incoming-webhook failure digest). Different
-- mechanism (bot token vs webhook URL), different account, zero shared columns.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Per-location Slack connection columns ───────────────────────────────────
alter table public.locations
  add column if not exists slack_bot_token   text,
  add column if not exists slack_team_id     text,
  add column if not exists slack_team_name   text,
  add column if not exists slack_channel_id  text,
  add column if not exists slack_channel_name text,
  add column if not exists slack_connected   boolean not null default false;

comment on column public.locations.slack_bot_token is
  'Slack bot token (xoxb-…) from the "Add to Slack" OAuth install. SERVER-READ-ONLY — never selected into a browser payload. No refresh token: rotation is OFF, bot tokens do not expire.';
comment on column public.locations.slack_team_id is
  'Slack workspace/team id (oauth.v2.access team.id). Also the reconnect-to-a-different-workspace signal.';
comment on column public.locations.slack_team_name is
  'Slack workspace/team display name (oauth.v2.access team.name). Display field — safe to thread to the client.';
comment on column public.locations.slack_channel_id is
  'Target channel id for chat.postMessage (oauth.v2.access incoming_webhook.channel_id — chosen inside Slack''s own consent screen). SERVER gate + send target.';
comment on column public.locations.slack_channel_name is
  'Target channel display name (oauth.v2.access incoming_webhook.channel, e.g. "#leads"). Display field — safe to thread to the client.';
comment on column public.locations.slack_connected is
  'True once the "Add to Slack" OAuth install completed and a bot token is stored. Flipped false by disconnectSlackFromLocation. Drives the SlackCard state + the intake send gate.';

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='locations'
--     AND column_name IN ('slack_bot_token','slack_team_id','slack_team_name',
--                         'slack_channel_id','slack_channel_name','slack_connected')
--   ORDER BY column_name;
