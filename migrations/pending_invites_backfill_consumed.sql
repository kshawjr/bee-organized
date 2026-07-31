-- Backfill: consume the invites that silently failed to consume (issue #65).
--
-- Every pending_invites row created before the code fix has accepted_at = null
-- even though the invitee accepted (the consume UPDATE died on the missing
-- accepted_user_id column). As of the prod snapshot on 2026-07-30 that's 12
-- rows; 10 are already past invite_expires_at (the expiry guard blocks them),
-- but 2 (carol@, alex@ — the 7/24 Hive managers) are unexpired and their links
-- stay claimable until this runs. Shipping the code fix only closes NEW
-- accepts; this closes the existing hole.
--
-- Safe because we only stamp rows whose invitee already has a hub_users
-- account at the invite's location (or a corporate/admin invite) — i.e. the
-- invite was demonstrably used. A genuinely-pending, not-yet-accepted invite
-- has no matching hub_users row and is left untouched.
--
-- accepted_at is the load-bearing single-use signal and needs no schema change,
-- so this runs independently of pending_invites_accepted_user_id.sql. Run the
-- column migration too if you want accepted_user_id populated for the audit
-- trail (optional; not required to close the vulnerability).
--
-- Apply via Supabase SQL editor. Idempotent: re-running only touches rows still
-- at accepted_at IS NULL.

-- Note: hub_users.location_id is text while pending_invites.location_id is
-- uuid, so the location match casts pi.location_id to text (uuid = text has no
-- operator in Postgres).
UPDATE public.pending_invites pi
SET accepted_at = COALESCE(hu.invite_accepted_at, now())
FROM public.hub_users hu
WHERE pi.accepted_at IS NULL
  AND lower(hu.email) = lower(pi.email)
  AND (pi.location_id::text = hu.location_id OR pi.tier = 'admin');
