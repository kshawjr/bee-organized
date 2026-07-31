-- pending_invites.accepted_user_id — repair a schema drift.
--
-- The column IS declared in invite_tokens.sql, but that file creates the table
-- with CREATE TABLE IF NOT EXISTS. Production's pending_invites predates the
-- column, so re-running invite_tokens.sql is a no-op and the column never
-- landed. The accept route (app/api/hub_users/accept) wrote BOTH accepted_at
-- and accepted_user_id in one UPDATE; PostgREST rejects the whole statement
-- when accepted_user_id is unknown (PGRST204), so accepted_at was never set
-- either — every invite stayed unconsumed and its "already accepted" 410 guard
-- never armed (issue #65).
--
-- The code fix (splitting the consume write) makes acceptance work WITHOUT this
-- column: accepted_at is written on its own and is the load-bearing consume
-- signal. This migration is purely to restore the audit trail — once applied,
-- the route's best-effort audit write starts populating accepted_user_id with
-- no further code change. Safe to run before or after the deploy; safe to
-- re-run.
--
-- Apply via Supabase SQL editor.

ALTER TABLE public.pending_invites
  ADD COLUMN IF NOT EXISTS accepted_user_id uuid REFERENCES auth.users(id);
