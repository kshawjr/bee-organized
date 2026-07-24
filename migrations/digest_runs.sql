-- migrations/digest_runs.sql
-- ─────────────────────────────────────────────────────────────
-- REVIEW ARTIFACT — apply via the Supabase SQL editor (Kevin-run DDL).
-- The app ships BEFORE this table exists and fails safe without it:
-- the digest cron's insert swallows "relation does not exist", and the
-- System Health screen shows "run tracking not wired yet" — the same
-- ships-before-the-table posture as notification_log.
--
-- WHY. The webhook-digest cron (app/api/cron/webhook-digest, 0 */3 UTC)
-- reads, posts to Slack, and forgets — no run leaves a durable trace.
-- That makes two things unknowable in-app:
--   1. "What did the last digest say?"
--   2. "Is the digest cron ALIVE?" — Vercel crons pin to the deployment
--      that registered them; a digest silent for 6+ hours means a
--      stale-deployment cron, and Slack silence looks identical to a
--      quiet period. "last ran 14h ago" catches it; nothing else does.
-- One row PER RUN — including suppressed runs (a quiet window is still
-- a heartbeat) and no_webhook_url skips. ~8 rows/day.
--
-- Service-role only (the reading route is the gate) — RLS on, no
-- policies, same posture as notification_log.

CREATE TABLE IF NOT EXISTS public.digest_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at               timestamptz NOT NULL DEFAULT now(),
  window_label         text,                          -- 'last 3h'
  suppressed           boolean NOT NULL DEFAULT false, -- quiet window, nothing posted
  posted               boolean NOT NULL DEFAULT false, -- Slack accepted the message
  skipped              text,                          -- e.g. 'no_webhook_url'
  all_clear            boolean,
  -- The numeric payload of lib/webhook-digest's WebhookDigest, so the
  -- summary can replay what a run saw without re-deriving it.
  leads_landed         integer,
  leads_failed         integer,
  jobber_landed        integer,
  jobber_didnt_land    integer,
  self_heals           integer,
  loc_other_leads      integer,
  import_failed        integer,
  import_stalled       integer,
  import_origin_gated  boolean,
  rate_missing         integer,
  booking_link_missing integer,
  -- The rendered Slack message (null for suppressed runs — nothing was
  -- rendered). Kept so "what did the last digest say" is answerable
  -- verbatim, not reconstructed.
  message_text         text
);

CREATE INDEX IF NOT EXISTS idx_digest_runs_ran_at
  ON public.digest_runs (ran_at DESC);

ALTER TABLE public.digest_runs ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon/authed clients get nothing; reads and
-- writes go through the service role, and the API route is the gate.
