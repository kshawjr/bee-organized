-- Subscription seats: pool model. Each row is a discrete seat that may be
-- assigned to a user or held unassigned. Owners purchase seats during
-- onboarding's Activate flow; corporate adds bulk seats; later flows assign
-- those seats to specific hub_users.
--
-- FK targets:
--   location_id → locations.id (uuid PK; locations.location_id is the Zoho text slug)
--   user_id    → auth.users.id (Supabase auth uid; hub_users.id mirrors this)
--   added_by   → auth.users.id (audit trail)
--
-- Soft-delete via status='inactive' + removed_at; we never hard-delete because
-- prorated_cost ties to a real charge.
--
-- Apply via Supabase SQL editor before testing the Activate flow — without
-- this table, the onboarding Activate POST will return 500.

CREATE TABLE IF NOT EXISTS public.subscription_seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  tier            text NOT NULL CHECK (tier IN ('owner', 'manager', 'light', 'readonly')),
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  prorated_cost   integer,  -- cents, for audit/Stripe later; null for prepaid/sponsored
  added_by        uuid REFERENCES auth.users(id),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_seats_location
  ON public.subscription_seats(location_id);

CREATE INDEX IF NOT EXISTS idx_subscription_seats_user
  ON public.subscription_seats(user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscription_seats_unassigned
  ON public.subscription_seats(location_id, tier)
  WHERE user_id IS NULL AND status = 'active';

ALTER TABLE public.subscription_seats ENABLE ROW LEVEL SECURITY;

-- Read: super_admin/admin see all; owners (and any hub_user at the location) see their location.
CREATE POLICY "subscription_seats read"
  ON public.subscription_seats FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = subscription_seats.location_id
        )
    )
  );

-- Write: super_admin/admin OR the owner of the seat's location.
-- Single FOR ALL policy covers INSERT/UPDATE/DELETE with USING + WITH CHECK.
CREATE POLICY "subscription_seats write"
  ON public.subscription_seats FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner' AND hub_users.location_id = subscription_seats.location_id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner' AND hub_users.location_id = subscription_seats.location_id)
        )
    )
  );
