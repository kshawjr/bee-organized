-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/slack_auto_channels.sql — a switch for automatic job channels
-- (Jobber crew → Slack, slice 3 of 3)
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN. Kevin runs it.
--
--   locations.slack_auto_channels_at
--       The switch AND its stamp, in one column so one can never exist
--       without the other. NULL = off (every location, until its owner turns
--       it on in Settings › Slack). A time = on since then. Only a job that
--       Jobber says was created AFTER this time can get an automatic channel,
--       so turning it on never sweeps up existing jobs. Turning it off and on
--       again moves the time forward: jobs made while it was off stay
--       without.
--   locations.slack_auto_channels_capped_at
--       The last time the daily ceiling stopped an automatic channel
--       (lib/job-channel-auto.ts AUTO_CHANNEL_DAILY_CAP). Shown on the switch
--       so the owner is told. Cleared when the switch is turned off.
--   engagements.slack_channel_auto_at
--       When Bee Hub claimed this job for an automatic channel. Claimed
--       BEFORE Slack is asked, by a write that only one caller can win, so
--       two notices for the same job in the same second make one channel.
--       The ceiling counts these stamps over the last 24 hours.
--
-- BEFORE THIS RUNS: the switch says it is not available yet, the save route
-- refuses, and JOB_CREATE makes no channel (the stamp column cannot be
-- claimed, so Slack is never asked). Everything else is exactly as it was.
--
-- Three empty columns and one small index. Touches no row. Safe to re-run.
-- UNDO: migrations/slack_auto_channels_undo.sql
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.locations
  add column if not exists slack_auto_channels_at timestamptz,
  add column if not exists slack_auto_channels_capped_at timestamptz;

alter table public.engagements
  add column if not exists slack_channel_auto_at timestamptz;

-- The ceiling's count: this location's claims in the last 24 hours.
create index if not exists engagements_slack_channel_auto_idx
  on public.engagements (location_uuid, slack_channel_auto_at)
  where slack_channel_auto_at is not null;
