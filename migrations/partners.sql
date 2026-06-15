-- Partners + Contacts + Companies: the real backend for the CRM module that
-- BeeHub's "Contacts" tab renders (PartnersScreen → Partners / Contacts /
-- Companies). Replaces the in-file PARTNERS_DATA and COMPANIES_DATA mock arrays.
--
-- Two tables:
--   partners  — one row per partner OR contact (type discriminator). Carries the
--               rich shape the UI actually reads: pipeline stage, specialties,
--               tier, tags, plus embedded sub-records (notes / next_steps /
--               referrals / activity) as jsonb. We keep these embedded because
--               the UI mutates whole-object snapshots via setPartners — there is
--               no per-subrecord query path, so jsonb matches the access pattern.
--   companies — organizations partners/contacts link to via partners.company_id.
--
-- FK targets:
--   location_id → locations.id (uuid PK; locations.location_id is the Zoho text slug)
--   company_id  → companies.id (uuid; nulled if the company row is deleted)
--   created_by  → auth.users.id (audit trail)
--
-- Soft-delete via deleted_at (UI reads `isDeleted`/`deletedAt`; the API maps
-- deleted_at ⇄ those). The recycle bin restores by nulling deleted_at and purges
-- with a hard DELETE.
--
-- RLS mirrors subscription_seats / pending_invites EXACTLY: hub_users.location_id
-- is uuid, so we compare it directly to <table>.location_id with NO ::text cast.
-- (The task spec asked for a ::text cast, but the two existing, applied policies
-- it told us to mirror use no cast on uuid columns — a text comparison there
-- would error at evaluation. We follow the proven pattern.)
--
-- Apply via Supabase SQL editor BEFORE testing — without these tables the
-- /api/partners and /api/companies routes return 500. Companies first (partners
-- has an FK to it).

-- ─── companies ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  industry      text,
  phone         text,
  email         text,
  website       text,
  addresses     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{type,value}]
  members       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- legacy/loose linkage list
  notes         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{id,text,ts,user}]
  activity      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{type,label,ts,user}]
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_companies_location
  ON public.companies(location_id);

CREATE INDEX IF NOT EXISTS idx_companies_name
  ON public.companies(location_id, name)
  WHERE deleted_at IS NULL;

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "companies read"
  ON public.companies FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = companies.location_id
        )
    )
  );

CREATE POLICY "companies write"
  ON public.companies FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = companies.location_id
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = companies.location_id
        )
    )
  );

-- ─── partners (partners + contacts) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.partners (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id      uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  type             text NOT NULL DEFAULT 'partner' CHECK (type IN ('partner', 'contact')),
  name             text NOT NULL,
  title            text,
  company          text,                 -- denormalized company name (UI shows it directly)
  company_id       uuid,                  -- SOFT ref to companies.id (no FK, like the mock's
                                          -- string refs + customer_lead_id). The UI joins
                                          -- client-side; a stale id just renders unlinked
                                          -- rather than erroring on write.
  phone            text,
  email            text,
  website          text,
  stage            text,                 -- 'New Contact','Reaching Out','Building','Active Partner','Contact', ...
  specialties      text[] NOT NULL DEFAULT '{}',
  tier             text,
  tags             text[] NOT NULL DEFAULT '{}',
  how_we_met       text,
  met_date         text,                 -- free-text in the UI ('Nov 2024', 'Just now') — not a real date
  last_contact     text,                 -- free-text ('Apr 28')
  is_customer      boolean NOT NULL DEFAULT false,
  customer_lead_id text,                 -- loose link to a lead when the partner is also a client
  relationship     text,                 -- contacts only ('Vendor', 'Realtor', ...)
  card_image       text,                 -- base64 SVG business card data URI
  addresses        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{type,value}]
  notes            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{id,text,ts,user}]
  next_steps       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{id,text,date,done,createdAt}]
  referrals        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{leadId,name,date,converted,revenue}]
  activity         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{type,label,ts,user}]
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_partners_location
  ON public.partners(location_id);

CREATE INDEX IF NOT EXISTS idx_partners_name
  ON public.partners(location_id, name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_partners_company
  ON public.partners(company_id)
  WHERE company_id IS NOT NULL;

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "partners read"
  ON public.partners FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = partners.location_id
        )
    )
  );

CREATE POLICY "partners write"
  ON public.partners FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = partners.location_id
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = partners.location_id
        )
    )
  );
