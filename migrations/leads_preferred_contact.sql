-- migrations/leads_preferred_contact.sql
--
-- Capture the inbound form's preferred contact method on the lead.
-- The webform/Make payload sends `preferred_contact` (e.g. "Text", "Email",
-- "Phone") mirroring Zoho's Preferred_Method_of_Contact field; before this
-- column intake had nowhere to store it and dropped the value.
--
-- Free-text (producer-agnostic) — the intake route normalizes to a trimmed
-- string, empty → NULL. No default: absence means "not stated".
--
-- Run in the Supabase SQL editor BEFORE deploying the intake wiring that
-- writes this column (a write to a missing column 400s the insert and would
-- lose a live lead).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS preferred_contact text;
