-- migrations/locations_jobber_team_roster.sql
--
-- Caches the Jobber team roster per location so Settings → Team can
-- present "candidate matches" for manual hub_users → jobber_user_id
-- linking without hitting Jobber on every page load.
--
-- jobber_user_id itself already exists on hub_users (added in
-- jobber_session_b.sql). This migration only adds the per-location
-- roster cache + sync timestamp.
--
-- Roster shape (jsonb): array of { id, name, email } objects, mirroring
-- Jobber's users { nodes { id, name { full }, email { raw } } } reply,
-- flattened by the syncRoster helper before write.
--
-- Idempotent. Safe to re-run.
--
-- Run via Supabase SQL editor.

alter table locations
  add column if not exists jobber_team_roster           jsonb,
  add column if not exists jobber_team_roster_synced_at timestamptz;

-- Speed up the email-match lookup we run on invite-accept:
--   "is this email anywhere in the cached roster for this location?"
-- Partial index on the synced_at timestamp keeps it tight to actually-
-- populated rows.
create index if not exists idx_locations_jobber_team_roster_synced
  on locations(jobber_team_roster_synced_at)
  where jobber_team_roster_synced_at is not null;

-- ─── hub_users.jobber_user_id index ─────────────────────────────────────────
-- The column exists (jobber_session_b.sql) but no supporting index. Most
-- reads are by hub_user.id, but the assignment-gating filter and "any
-- linked teammates yet?" check both scan jobber_user_id IS NOT NULL.

create index if not exists idx_hub_users_jobber_user_id
  on hub_users(jobber_user_id)
  where jobber_user_id is not null;
