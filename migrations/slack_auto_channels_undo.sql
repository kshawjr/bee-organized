-- Undo for slack_auto_channels.sql. Every location reads as switched off
-- again and no job channel is made automatically. Channels already made stay
-- (they are engagements.slack_channel_id, which this does not touch).
drop index if exists public.engagements_slack_channel_auto_idx;

alter table public.engagements
  drop column if exists slack_channel_auto_at;

alter table public.locations
  drop column if exists slack_auto_channels_at,
  drop column if exists slack_auto_channels_capped_at;
