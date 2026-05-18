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
CREATE POLICY "pending_invites read"
  ON public.pending_invites FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = pending_invites.location_id
        )
    )
  );

-- Write: super_admin/admin OR the location owner. App-layer checks in
-- /api/hub_users/invite are the real gate; this RLS policy backstops.
CREATE POLICY "pending_invites write"
  ON public.pending_invites FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner' AND hub_users.location_id = pending_invites.location_id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner' AND hub_users.location_id = pending_invites.location_id)
        )
    )
  );

-- Audit columns on hub_users so accepted invitees can be traced.
ALTER TABLE public.hub_users
  ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS invite_accepted_at timestamptz;
