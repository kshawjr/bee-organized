-- Shareable Slack "team invite" URL for a location.
-- Pasted + saved by the owner on the SlackCard (Settings → Communications),
-- then copied and sent to teammates so they can join the location's Slack.
--
-- Browser-safe (a shareable invite link, unlike slack_bot_token which stays
-- server-only). Nullable — locations without an invite link render an empty
-- field. LOCATION invite only; corporate/community invites are not stored here.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS slack_invite_url TEXT;
