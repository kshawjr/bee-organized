-- migrations/engagements_written_off_amount.sql
--
-- The WRITTEN-OFF close (2026-09-27). A written-off deal is stored as
-- stage 'Closed Lost' + closed_reason 'written_off' (see
-- components/hive/shared/writtenOff.js); this column records HOW MUCH was
-- written off, because that is the number that matters later.
--
-- Written by the PATCH route when an owner writes a deal off (computed
-- server-side from the engagement's invoices, never taken from the
-- browser), cleared by Reopen, and kept true by
-- scripts/repair-invoice-balances.mjs when Jobber's real figures land.
--
-- Nullable, no default: every existing row is untouched and NULL means
-- "not written off". Never read as revenue — nothing that totals money
-- selects it.
--
-- RUN THIS BEFORE THE CODE SHIPS. The write-off close and Reopen of a
-- written-off deal write this column; without it those two actions fail.
-- Nothing else touches it.
--
-- Safe to re-run (IF NOT EXISTS). Run in the Supabase SQL editor.

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS written_off_amount numeric;

COMMENT ON COLUMN engagements.written_off_amount IS
  'Amount written off when the deal closed as Written off (stage Closed Lost + closed_reason written_off). NULL otherwise. Never revenue.';
