-- migrations/lead_former_addresses.sql
--
-- A client can hold more than one address: the CURRENT one stays exactly
-- where it has always lived (leads.address/city/state/zip, with its Jobber
-- property link in leads.jobber_property_id), and addresses they have moved
-- AWAY from accumulate here.
--
-- HELD: run this by hand (Kevin). Run it BEFORE deploying the code that
-- uses it — the "They moved" save stores the old address in this column and
-- fails calm (never silently dropping the old address) while the column is
-- absent.
--
-- WHY A SEPARATE COLUMN and not the existing `addresses` jsonb: that array
-- is a one-element convention (27 rows, zero with more than one) whose
-- [0].street feeds the send-to-Jobber property step — giving it a second
-- meaning ("also holds history") would hand every reader of it a decision
-- it never had to make. And why not new rows in a table: every existing
-- reader of a lead's address — the card, send-to-Jobber, the write-back,
-- the webhooks, notifications — reads the four columns, and this design
-- changes NONE of them. Current address semantics are untouched; history
-- is strictly additive.
--
-- SHAPE of each entry (written by the "They moved" branch of the lead
-- PATCH; the reader is lib/lead-address + the client card):
--   {
--     "street":  "123 Old St",         -- the street line (unit included)
--     "city":    "Fairway",
--     "state":   "KS",
--     "zip":     "66205",
--     "display": "123 Old St, Fairway, KS, 66205",
--     "jobber_property_id": "12345",   -- the Jobber property this address
--                                      -- IS; null when the client was not
--                                      -- linked or the property is unknown
--     "moved_at": "2026-08-30T12:00:00Z"
--   }
--
-- The Jobber property link per entry is what routes an inbound
-- PROPERTY_UPDATE for an old property to the right stored address instead
-- of stomping the current one.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS former_addresses jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN leads.former_addresses IS
  'Addresses this client moved away from, newest last. Each entry: {street, city, state, zip, display, jobber_property_id, moved_at}. The CURRENT address stays in address/city/state/zip + jobber_property_id. Appended only by the "They moved" branch of PATCH /api/leads/:id; entries are never edited from the card. Inbound PROPERTY_UPDATE events for an old property update the matching entry here.'


-- ─── EXISTING ROWS: NOTHING HAPPENS, AND NOTHING CAN ─────────────────
--
-- ADD COLUMN with a constant DEFAULT on this Postgres version is a
-- metadata-only change: no row is rewritten, the default is stored once
-- and served for every existing row. Every current client keeps its one
-- address, byte for byte, in the same columns every screen already reads.
-- No owner can see anything move, because nothing moves — the new column
-- reads as an empty list everywhere until the first "They moved" save
-- writes an entry.
--
-- There is deliberately NO backfill here. If Kevin ever wants Jobber-side
-- extra properties reflected as stored addresses for existing clients,
-- that is a separate read-then-write artifact he runs separately.


-- ─── VERIFY AFTER RUNNING ────────────────────────────────────────────
--
--   SELECT count(*) FROM leads WHERE former_addresses <> '[]'::jsonb;
--   -- expect: 0 (until the first real move is saved)
--
--   SELECT column_name, column_default FROM information_schema.columns
--   WHERE table_name = 'leads' AND column_name = 'former_addresses';
--   -- expect: jsonb, default '[]'::jsonb


-- ─── ROLLBACK ────────────────────────────────────────────────────────
--
-- Safe ONLY while no row carries an entry (check the count above first —
-- dropping the column discards any stored former addresses):
--
--   ALTER TABLE leads DROP COLUMN IF EXISTS former_addresses;
