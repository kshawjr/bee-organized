-- Pending team invites + accept-flow audit fields on hub_users.
--
-- Why a separate pending_invites table (not invite columns on hub_users):
--   hub_users.id is the PRIMARY KEY and FK-constrained to auth.users(id).
--   Pre-auth invite rows can't live in hub_users without dropping the FK
--   or making `id` nullable — both touch RLS-critical surface area and
--   were rejected as too risky for a demo migration. pending_invites
--   uses its own surrogate uuid; it carries no auth side-effects until
--   accept time, when /api/hub_users/accept inserts the real hub_users
--   row keyed by auth.uid().
--
-- Seat reservation model:
--   We DO NOT pre-claim a subscription_seats row when the invite is
--   created. subscription_seats.user_id FKs auth.users — claiming with
--   a non-auth uuid would require dropping that FK. Instead we count
--   pending_invites at (location, tier) against the available pool on
--   the client/UI side. Seats are claimed at accept time by PATCHing
--   one available subscription_seats row to user_id = auth.uid().
--
-- Apply via Supabase SQL editor before testing the invite flow. Without
-- this table, POST /api/hub_users/invite returns 500.

CREATE TABLE IF NOT EXISTS public.pending_invites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  email               text NOT NULL,
  full_name           text,
  role                text NOT NULL CHECK (role IN ('owner','admin','lite_user','super_admin')),
  tier                text NOT NULL CHECK (tier IN ('owner','manager','light','readonly')),
  invite_token        text NOT NULL UNIQUE,
  invite_expires_at   timestamptz NOT NULL,
  invited_by          uuid REFERENCES auth.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  accepted_user_id    uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_pending_invites_token
  ON public.pending_invites(invite_token)
  WHERE accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_invites_location_tier
  ON public.pending_invites(location_id, tier)
  WHERE accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_invites_email
  ON public.pending_invites(lower(email))
  WHERE accepted_at IS NULL;

ALTER TABLE public.pending_invites ENABLE ROW LEVEL SECURITY;

-- Read: super_admin/admin OR any hub_user at the same location can see
-- their location's invites. The accept page reads via service role
-- (token lookup must work pre-auth), so RLS gates the Settings-side
-- listing only.
--
-- CAST: hub_users.location_id is TEXT; pending_invites.location_id is uuid.
-- The uuid side MUST be cast — hub_users.location_id = pending_invites.location_id::text.
-- Omitting it errors 42883 (operator does not exist: text = uuid). NEVER omit it.
DROP POLICY IF EXISTS "pending_invites read" ON public.pending_invites;
CREATE POLICY "pending_invites read"
  ON public.pending_invites FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = pending_invites.location_id::text
        )
    )
  );

-- Write: super_admin/admin OR the location owner. App-layer checks in
-- /api/hub_users/invite are the real gate; this RLS policy backstops.
DROP POLICY IF EXISTS "pending_invites write" ON public.pending_invites;
CREATE POLICY "pending_invites write"
  ON public.pending_invites FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner' AND hub_users.location_id = pending_invites.location_id::text)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner' AND hub_users.location_id = pending_invites.location_id::text)
        )
    )
  );

-- Audit columns on hub_users so accepted invitees can be traced.
ALTER TABLE public.hub_users
  ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS invite_accepted_at timestamptz;

-- Column backstop for pending_invites (#65 follow-up).
--
-- CREATE TABLE IF NOT EXISTS is a COMPLETE no-op on an already-existing
-- table — Postgres skips the whole statement, it does NOT diff and add
-- missing columns. So any column that was added to the CREATE body above
-- AFTER the table first shipped never lands on a DB that already had the
-- table. That is exactly how prod ended up with pending_invites but no
-- accepted_user_id — the root of #65. Same failure mode the hub_users
-- ALTER above already guards against; this mirrors that style for every
-- pending_invites column so a re-run reconciles the schema.
--
-- Note: later migrations altered some of these — pending_invites_corporate.sql
-- made location_id nullable and re-manages the tier CHECK as a named
-- constraint (pending_invites_tier_check, extended with 'admin'). That is
-- fine: on any existing DB each clause below hits an already-present column
-- and IF NOT EXISTS skips it, so this ALTER never re-imposes the original
-- NOT NULL / inline CHECK. It only adds columns that are genuinely missing.
ALTER TABLE public.pending_invites
  ADD COLUMN IF NOT EXISTS id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS email             text NOT NULL,
  ADD COLUMN IF NOT EXISTS full_name         text,
  ADD COLUMN IF NOT EXISTS role              text NOT NULL CHECK (role IN ('owner','admin','lite_user','super_admin')),
  ADD COLUMN IF NOT EXISTS tier              text NOT NULL CHECK (tier IN ('owner','manager','light','readonly')),
  ADD COLUMN IF NOT EXISTS invite_token      text NOT NULL UNIQUE,
  ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz NOT NULL,
  ADD COLUMN IF NOT EXISTS invited_by        uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS created_at        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS accepted_at       timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_user_id  uuid REFERENCES auth.users(id);
