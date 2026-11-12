-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/engagement_slack_channel.sql — a job's Slack channel
-- (Slack job channels, slice 3 of 3, part B)
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN. Kevin runs it.
--
--   slack_channel_id          the public channel made by "Put this job in
--                             Slack" (app/api/engagements/[id]/slack-channel).
--                             Never made automatically.
--   slack_channel_name        its name at creation (client-projecttype).
--   slack_channel_archived_at set by the sweep (/api/cron/job-channels) when
--                             the engagement closes; cleared when it reopens
--                             and the channel is unarchived.
--   slack_channel_problems    what the sweep's unattended reconcile (after an
--                             unarchive) could NOT do, e.g. a bee taken off
--                             the job whom the workspace won't let apps
--                             remove. Shown under the job's Bees cell until
--                             the owner taps Got it. Null = nothing to say.
--
-- BEFORE THIS RUNS: the panel shows no "Put this job in Slack" button and the
-- create route refuses BEFORE calling Slack (so no channel is ever made that
-- could not be remembered). The sweep reports not_set_up_yet and does nothing.
--
-- Four empty columns. Single statement. Touches no row. Safe to re-run.
-- UNDO: migrations/engagement_slack_channel_undo.sql
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.engagements
  add column if not exists slack_channel_id text,
  add column if not exists slack_channel_name text,
  add column if not exists slack_channel_archived_at timestamptz,
  add column if not exists slack_channel_problems jsonb;
