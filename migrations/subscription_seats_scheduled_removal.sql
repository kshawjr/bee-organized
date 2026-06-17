-- Scheduled seat removal at next renewal.
-- Owners cannot truly remove a paid seat today (RELEASE leaves the
-- seat in the billable pool). This adds a "marked for removal at
-- renewal" path. No mid-cycle credits per Kevin's decision.
--
-- Cron / manual super_admin job on March 1:
--   UPDATE subscription_seats SET status='inactive', removed_at=now()
--   WHERE scheduled_removal_at <= now() AND status='active';

ALTER TABLE subscription_seats
  ADD COLUMN IF NOT EXISTS scheduled_removal_at DATE;

CREATE INDEX IF NOT EXISTS subscription_seats_scheduled_removal_idx
  ON subscription_seats (scheduled_removal_at)
  WHERE scheduled_removal_at IS NOT NULL;
