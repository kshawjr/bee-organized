-- Tier prices: single source of truth for subscription seat pricing.
-- Replaces the two parallel hardcoded tables (DEFAULT_ROLE_PRICING in
-- BeeHub.jsx + TIER_PRICES in lib/subscription-math.ts) that disagreed
-- by $25 on manager/light. Apply via Supabase SQL editor before testing
-- Admin → Pricing edits.

CREATE TABLE IF NOT EXISTS public.tier_prices (
  id            text PRIMARY KEY CHECK (id IN ('owner', 'manager', 'light', 'readonly')),
  display_name  text NOT NULL,
  price_annual  integer NOT NULL CHECK (price_annual >= 0),
  description   text,
  sort_order    integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES auth.users(id)
);

-- Seed with the production-live TIER_PRICES values from lib/subscription-math.ts.
INSERT INTO public.tier_prices (id, display_name, price_annual, description, sort_order) VALUES
  ('owner',    'Zee Bee',       550, 'Full access — billing, settings, Jobber',              1),
  ('manager',  'Hive Manager',  400, 'Operational lead — no billing or Jobber',              2),
  ('light',    'Worker Bee',    200, 'Front office — intake, scheduling, customer service',  3),
  ('readonly', 'Honey Watcher',  50, 'Read-only — accountants, advisors',                    4)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.tier_prices ENABLE ROW LEVEL SECURITY;

-- Reads: any authenticated user (prices are not sensitive).
CREATE POLICY "tier_prices_select_authenticated"
  ON public.tier_prices FOR SELECT TO authenticated USING (true);

-- Writes: super_admin or admin (matches /api/admin/tier-prices allowedRoles
-- and mirrors manual_slides RLS pattern).
CREATE POLICY "tier_prices_insert_admins"
  ON public.tier_prices FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.hub_users
    WHERE hub_users.id = auth.uid()
      AND hub_users.role IN ('super_admin','admin')
  ));

CREATE POLICY "tier_prices_update_admins"
  ON public.tier_prices FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.hub_users
    WHERE hub_users.id = auth.uid()
      AND hub_users.role IN ('super_admin','admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.hub_users
    WHERE hub_users.id = auth.uid()
      AND hub_users.role IN ('super_admin','admin')
  ));

CREATE POLICY "tier_prices_delete_admins"
  ON public.tier_prices FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.hub_users
    WHERE hub_users.id = auth.uid()
      AND hub_users.role IN ('super_admin','admin')
  ));
