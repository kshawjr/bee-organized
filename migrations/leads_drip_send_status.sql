-- Add drip send status tracking to the leads table.
--
-- The numbered drip-path step sends (lib/drip-send.ts → sendDripStepForRow)
-- previously left no trace on the lead when they failed silently — a missing
-- location sender config (send_from_email/sender_name/reply_to_email) or a
-- Resend API error returns failure without throwing, the drip_path_steps /
-- lead_drip_progress row is left unchanged so it retries every cron tick
-- forever, and nothing surfaces in the app.
--
-- These four columns record the outcome of the *last* drip send attempt so
-- it can be surfaced on the lead/client record (PersonPanel). They are a
-- pure observability mirror — the drip progress/retry state is untouched.
--
-- Welcome/stage emails already write touchpoints and are unaffected.
--
-- All columns default NULL (no prior attempt). No RLS changes — the existing
-- leads table policies cover these columns.

alter table leads
  add column if not exists drip_last_send_status text,        -- 'sent' | 'failed' | 'no_email' | 'paused' | null
  add column if not exists drip_last_send_at     timestamptz,  -- when the last drip attempt happened
  add column if not exists drip_last_send_step    int,          -- which step number (1, 2, 3...)
  add column if not exists drip_last_send_error   text;         -- error message if failed (truncated to 500 chars)
