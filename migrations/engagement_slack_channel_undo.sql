-- migrations/engagement_slack_channel_undo.sql — undoes
-- migrations/engagement_slack_channel.sql. Bee Hub forgets every job channel
-- it made; the channels themselves stay in Slack. Export first if any:
--   select id, slack_channel_id, slack_channel_name from public.engagements
--   where slack_channel_id is not null;
alter table public.engagements
  drop column if exists slack_channel_problems,
  drop column if exists slack_channel_archived_at,
  drop column if exists slack_channel_name,
  drop column if exists slack_channel_id;
