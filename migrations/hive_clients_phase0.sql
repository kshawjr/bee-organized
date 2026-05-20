-- migrations/hive_clients_phase0.sql
--
-- Hive Clients Phase 0 schema
-- Date: 2026-05-19
-- Author: Kevin (designed with Claude)
--
-- Adds the schema needed to wire the Hive client experience end-to-end:
--   - leads gets several new columns (location_uuid, is_junk, drip paths,
--     reach-out tracking, close-out reason, addresses jsonb, stage CHECK)
--   - Stage taxonomy locked to 7 values: New, Nurturing, Estimate,
--     Job in Progress, Final Processing, Won, Lost
--   - location_id (text slug) → location_uuid (uuid) staged migration:
--     new column added + backfilled, old slug column stays for now,
--     post-launch cleanup migration will drop it
--   - New tables: lead_tags (junction → lookups), notes (4-kind enum),
--     lead_contacts (spouse/co-decision-maker), touchpoints
--     (reach-outs + drips + system events + stage changes),
--     drip_paths + drip_path_steps (per-location, fully customizable)
--   - All new tables have RLS enabled with NO public policies
--     (service-role-only writes via API routes — matches existing pattern)
--
-- Apply: wrap in transaction so it either fully applies or rolls back
--   BEGIN;
--   \i hive_clients_phase0.sql
--   COMMIT;
-- Or paste entire file into Supabase SQL editor and run.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. leads: add location_uuid + backfill from slug
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS location_uuid uuid REFERENCES locations(id);

-- Backfill location_uuid from existing location_id slug
UPDATE leads l
SET location_uuid = loc.id
FROM locations loc
WHERE l.location_id = loc.location_id
  AND l.location_uuid IS NULL;

-- Index for the new column (we'll query by it constantly)
CREATE INDEX IF NOT EXISTS idx_leads_location_uuid ON leads(location_uuid);

-- ──────────────────────────────────────────────────────────────────────────
-- 2. leads: stage CHECK constraint (lock to 7 values)
-- ──────────────────────────────────────────────────────────────────────────

-- Drop any existing stage check constraint first (safety)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_stage_check;

-- Lock stage values
ALTER TABLE leads
  ADD CONSTRAINT leads_stage_check
  CHECK (stage IN (
    'New',
    'Nurturing',
    'Estimate',
    'Job in Progress',
    'Final Processing',
    'Won',
    'Lost'
  ));

-- ──────────────────────────────────────────────────────────────────────────
-- 3. leads: new columns
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_junk boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drip_path text,
  ADD COLUMN IF NOT EXISTS move_drip_path text,
  ADD COLUMN IF NOT EXISTS final_processed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS final_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_lost_reason text,
  ADD COLUMN IF NOT EXISTS closed_lost_note text,
  ADD COLUMN IF NOT EXISTS referred_by_kind text
    CHECK (referred_by_kind IS NULL OR referred_by_kind IN ('partner', 'lead')),
  ADD COLUMN IF NOT EXISTS referred_by_id uuid,
  ADD COLUMN IF NOT EXISTS addresses jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill: existing leads with a non-null address column get a default
-- Service address row in the new addresses jsonb column
UPDATE leads
SET addresses = jsonb_build_array(
  jsonb_build_object(
    'type', 'Service',
    'value', address,
    'street', COALESCE(address, ''),
    'city', COALESCE(city, ''),
    'state', COALESCE(state, ''),
    'zip', COALESCE(zip, '')
  )
)
WHERE address IS NOT NULL
  AND address <> ''
  AND addresses = '[]'::jsonb;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. lead_tags: junction table linking leads to lookups (tag definitions)
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_tags (
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_lookup_id uuid NOT NULL REFERENCES lookups(id) ON DELETE RESTRICT,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES hub_users(id),
  PRIMARY KEY (lead_id, tag_lookup_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_tags_lead ON lead_tags(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_tags_tag ON lead_tags(tag_lookup_id);

ALTER TABLE lead_tags ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. notes: typed notes (buzz / job / close / system)
-- ──────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE note_kind AS ENUM ('buzz', 'job', 'close', 'system');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  location_uuid uuid NOT NULL REFERENCES locations(id),
  kind note_kind NOT NULL,
  text text NOT NULL,
  user_id uuid REFERENCES hub_users(id),
  user_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_lead ON notes(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_location ON notes(location_uuid);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. lead_contacts: spouse / co-decision-maker on a lead
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  location_uuid uuid NOT NULL REFERENCES locations(id),
  name text NOT NULL,
  role text,
  phone text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_contacts_lead ON lead_contacts(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_location ON lead_contacts(location_uuid);

ALTER TABLE lead_contacts ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────────
-- 7. touchpoints: reach-outs, drip sends, system events, stage changes
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  location_uuid uuid NOT NULL REFERENCES locations(id),
  kind text NOT NULL
    CHECK (kind IN ('reach_out', 'drip', 'system', 'stage_change', 'note')),
  method text
    CHECK (method IS NULL OR method IN ('call', 'sms', 'email', 'system', 'call_prompt', 'in_person')),
  label text NOT NULL,
  status text,
  drip_id uuid,
  notes text,
  user_id uuid REFERENCES hub_users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_touchpoints_lead ON touchpoints(lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_touchpoints_location ON touchpoints(location_uuid);
CREATE INDEX IF NOT EXISTS idx_touchpoints_kind ON touchpoints(kind);

ALTER TABLE touchpoints ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────────
-- 8. drip_paths: per-location, fully customizable
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS drip_paths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_uuid uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  path_key text NOT NULL,                     -- 'new-lead', 'move-in', 'move-out', etc.
  name text NOT NULL,                          -- 'New Lead Path A' (display name)
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_uuid, path_key, name)
);

CREATE INDEX IF NOT EXISTS idx_drip_paths_location ON drip_paths(location_uuid);
CREATE INDEX IF NOT EXISTS idx_drip_paths_path_key ON drip_paths(path_key);

ALTER TABLE drip_paths ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────────
-- 9. drip_path_steps: ordered steps within a drip path
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS drip_path_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drip_path_id uuid NOT NULL REFERENCES drip_paths(id) ON DELETE CASCADE,
  step_order int NOT NULL,
  delay_days int NOT NULL DEFAULT 0,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  subject text,                                -- nullable for sms
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drip_path_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_drip_path_steps_path ON drip_path_steps(drip_path_id, step_order);

ALTER TABLE drip_path_steps ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────────
-- 10. Updated_at triggers (drip_paths + drip_path_steps)
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_drip_paths_updated_at ON drip_paths;
CREATE TRIGGER trg_drip_paths_updated_at
  BEFORE UPDATE ON drip_paths
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_drip_path_steps_updated_at ON drip_path_steps;
CREATE TRIGGER trg_drip_path_steps_updated_at
  BEFORE UPDATE ON drip_path_steps
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────────────────
-- Done.
-- ──────────────────────────────────────────────────────────────────────────

COMMIT;

-- Verify after running:
--   SELECT count(*) FROM leads WHERE location_uuid IS NOT NULL;  -- should be 52
--   SELECT column_name FROM information_schema.columns WHERE table_name='leads' AND column_name IN ('is_junk','drip_path','addresses');
--   SELECT count(*) FROM lead_tags;          -- 0 (empty until we backfill app side)
--   \d notes
--   \d touchpoints
--   \d drip_paths