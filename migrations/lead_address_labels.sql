-- migrations/lead_address_labels.sql
--
-- THE ADDRESS MODEL — the label for a lead's PRIMARY address.
--
-- HELD. Kevin runs this. Run it BEFORE deploying, or the add / retire /
-- relabel route answers 503 'addresses_not_available_yet' (it names the
-- pending migration rather than 500-ing) and the client profile serves the
-- card without labels. Editing an address is unaffected either way.
--
-- WHAT THIS IS NOT. It creates no table and moves no data. The client's OTHER
-- addresses already have a home: leads.former_addresses, added by
-- lead_former_addresses.sql and still EMPTY on all 21,055 rows — the move
-- flow it was built for never ran once in eight weeks. The address model
-- reuses that column as a plain list of the client's other addresses, each
-- entry gaining `label`, `label_note` and `status` keys. jsonb needs no
-- migration for that, and because the column is empty there is nothing to
-- convert and no backfill to get wrong.
--
-- The column keeps its historical name. Renaming it would touch the inbound
-- Jobber webhook's jsonb containment filter and six modules for no
-- owner-visible gain; what it means now is documented in lib/lead-address.ts.
--
-- Metadata-only. Both columns are nullable with no default, so every existing
-- row is untouched and reads as "unlabelled" — which renders exactly as the
-- card does today.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS address_label      text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS address_label_note text;

-- The fixed five (lib/address-labels.ts is the single source of truth; this
-- is the database refusing anything else). NULL stays legal — it is the
-- unlabelled state every current row is in.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_address_label_check;
ALTER TABLE leads ADD CONSTRAINT leads_address_label_check
  CHECK (address_label IS NULL OR address_label IN
    ('home', 'second_home', 'office', 'storage', 'other'));

-- 'Other' is the escape hatch, and an escape hatch that says nothing is worse
-- than no label at all — so it must carry a note. Enforced in the route
-- (other_label_requires_a_note) and here, so neither can drift.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_address_label_note_check;
ALTER TABLE leads ADD CONSTRAINT leads_address_label_note_check
  CHECK (address_label IS DISTINCT FROM 'other'
         OR (address_label_note IS NOT NULL AND btrim(address_label_note) <> ''));

-- ── Rollback ────────────────────────────────────────────────────────────
-- Safe at any time; the app treats a missing column as "labels not available
-- yet" and keeps editing addresses normally.
--
--   ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_address_label_note_check;
--   ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_address_label_check;
--   ALTER TABLE leads DROP COLUMN IF EXISTS address_label_note;
--   ALTER TABLE leads DROP COLUMN IF EXISTS address_label;
