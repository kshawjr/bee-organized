-- migrations/hive_clients_phase0.sql
--
-- Hive Clients Phase 0 schema
-- Date: 2026-05-19
--
-- Adds the schema needed to wire the Hive client experience end-to-end.
-- Re-runnable: all guards prevent failure if any object already exists.
--
-- Note: Bee Hub already has a `notes` table from earlier work tied to
-- Jobber's note system. This migration creates a SEPARATE `lead_notes`
-- table for internal-only buzz/job/close/system notes. The two are
-- different concepts:
--   - notes       = Jobber-synced notes (has jobber_note_id, etc.)
--   - lead_notes  = Internal-only notes (buzz/job/close/system kinds)

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 1 — leads.location_uuid + backfill + index
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS location_uuid uuid REFERENCES locations(id);

UPDATE leads l
SET location_uuid = loc.id
FROM locations loc
WHERE l.location_id = loc.location_id
  AND l.location_uuid IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_location_uuid ON leads(location_uuid);

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 2 — leads stage CHECK constraint (lock to 7 values)
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_stage_check;

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

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 3 — leads: new columns
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_junk boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drip_path text,
  ADD COLUMN IF NOT EXISTS move_drip_path text,
  ADD COLUMN IF NOT EXISTS final_processed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS final_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_lost_reason text,
  ADD COLUMN IF NOT EXISTS closed_lost_note text,
  ADD COLUMN IF NOT EXISTS referred_by_kind text,
  ADD COLUMN IF NOT EXISTS referred_by_id uuid,
  ADD COLUMN IF NOT EXISTS addresses jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_referred_by_kind_check;
ALTER TABLE leads
  ADD CONSTRAINT leads_referred_by_kind_check
  CHECK (referred_by_kind IS NULL OR referred_by_kind IN ('partner', 'lead'));

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

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 4 — lead_tags junction (lead → lookups)
-- ══════════════════════════════════════════════════════════════════════════

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

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 5 — lead_notes (internal-only buzz/job/close/system)
-- ══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE note_kind AS ENUM ('buzz', 'job', 'close', 'system');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS lead_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  location_uuid uuid NOT NULL REFERENCES locations(id),
  kind note_kind NOT NULL,
  text text NOT NULL,
  user_id uuid REFERENCES hub_users(id),
  user_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_notes_location ON lead_notes(location_uuid);

ALTER TABLE lead_notes ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 6 — lead_contacts
-- ══════════════════════════════════════════════════════════════════════════

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

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 7 — touchpoints
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  location_uuid uuid NOT NULL REFERENCES locations(id),
  kind text NOT NULL,
  method text,
  label text NOT NULL,
  status text,
  drip_id uuid,
  notes text,
  user_id uuid REFERENCES hub_users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE touchpoints DROP CONSTRAINT IF EXISTS touchpoints_kind_check;
ALTER TABLE touchpoints
  ADD CONSTRAINT touchpoints_kind_check
  CHECK (kind IN ('reach_out', 'drip', 'system', 'stage_change', 'note'));

ALTER TABLE touchpoints DROP CONSTRAINT IF EXISTS touchpoints_method_check;
ALTER TABLE touchpoints
  ADD CONSTRAINT touchpoints_method_check
  CHECK (method IS NULL OR method IN ('call', 'sms', 'email', 'system', 'call_prompt', 'in_person'));

CREATE INDEX IF NOT EXISTS idx_touchpoints_lead ON touchpoints(lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_touchpoints_location ON touchpoints(location_uuid);
CREATE INDEX IF NOT EXISTS idx_touchpoints_kind ON touchpoints(kind);

ALTER TABLE touchpoints ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 8 — drip_paths (per-location, fully customizable)
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS drip_paths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_uuid uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  path_key text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_uuid, path_key, name)
);

CREATE INDEX IF NOT EXISTS idx_drip_paths_location ON drip_paths(location_uuid);
CREATE INDEX IF NOT EXISTS idx_drip_paths_path_key ON drip_paths(path_key);

ALTER TABLE drip_paths ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 9 — drip_path_steps
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS drip_path_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drip_path_id uuid NOT NULL REFERENCES drip_paths(id) ON DELETE CASCADE,
  step_order int NOT NULL,
  delay_days int NOT NULL DEFAULT 0,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  subject text,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drip_path_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_drip_path_steps_path ON drip_path_steps(drip_path_id, step_order);

ALTER TABLE drip_path_steps ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 10 — updated_at triggers
-- ══════════════════════════════════════════════════════════════════════════

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