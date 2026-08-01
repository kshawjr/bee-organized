-- migrations/alert_runs.sql
-- ─────────────────────────────────────────────────────────────
-- REVIEW ARTIFACT — apply via the Supabase SQL editor (Kevin-run DDL).
-- The app ships BEFORE this table exists and fails safe without it: the
-- failure-alert cron reads the last watermark, gets "relation does not
-- exist", treats it as "no prior watermark" (which seeds the window at
-- ~now and posts nothing), and the recordAlertRun write swallows the same
-- error. So pre-migration the cron is a silent no-op — no spam, no crash —
-- the same ships-before-the-table posture as digest_runs / notification_log
-- (issue 159).
--
-- WHY. The webhook digest is now once daily (0 10 UTC). Real-time failures
-- need a faster channel, so app/api/cron/failure-alerts runs every ~5 min
-- and posts an instant Slack alert for an ALLOWLIST of hard failures
-- (sync_log not_landed, import_jobs failed, genuine Jobber token expiry,
-- ASSESSMENT_TEAM_MISMATCH). To alert each failure EXACTLY ONCE it dedupes
-- on a stored high-water mark: every run considers only rows created after
-- the last watermark, then advances the watermark. Same pattern as
-- digest_runs' recordDigestRun, but the row carries the dedup cursor, not
-- just a heartbeat.
--
-- The watermark trails now() by the self-heal settle window (5 min) so a
-- reauth failure has its full self-heal window to resolve before we decide
-- it is a genuine expiry — the cron never commits past now-5min, so a token
-- race that heals at minute 2 is never alerted. One row per run (~288/day);
-- prune with the same posture as any other append log if it ever matters.
--
-- Service-role only (the cron route is the gate) — RLS on, no policies,
-- same posture as digest_runs / notification_log.

CREATE TABLE IF NOT EXISTS public.alert_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at     timestamptz NOT NULL DEFAULT now(),
  -- The dedup cursor: every row with created_at (sync_log) / completed_at
  -- (import_jobs) at-or-before this instant has been considered. The next
  -- run reads rows strictly after it. Trails now() by the 5-min settle.
  watermark  timestamptz NOT NULL,
  alerted    integer NOT NULL DEFAULT 0,     -- alert lines posted this run
  posted     boolean NOT NULL DEFAULT false, -- Slack accepted the message
  skipped    text                            -- e.g. 'no_webhook_url'
);

CREATE INDEX IF NOT EXISTS idx_alert_runs_ran_at
  ON public.alert_runs (ran_at DESC);

ALTER TABLE public.alert_runs ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon/authed clients get nothing; reads and writes
-- go through the service role, and the cron route is the gate.
