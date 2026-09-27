-- migrations/drip_enrol_reason.sql
--
-- REVIEW ARTIFACT — NOT EXECUTED. Run in the Supabase SQL editor after Kevin
-- approves. Additive: two nullable columns and one index. No data movement.
--
-- ── PURPOSE ────────────────────────────────────────────────────────────
-- WHY a lead did or didn't start nurture emails, stored on the lead — the way
-- leads.drip_last_send_* stores the last send. Until now startDripForLead
-- returned nothing from twelve places and wrote nothing anywhere an owner or
-- Kevin could see: Test Fornat (Test Location, 2026-09-27) went in with Drip
-- ticked and never enrolled, and the only trace was one server log line.
--
--   drip_enrol_reason  NULL once enrolled; otherwise one of
--                        drip_not_ticked · paused_import · opted_out ·
--                        location_not_live · no_default_path · path_missing ·
--                        path_has_no_first_email · lookup_failed
--                      (lib/drip-enrol-outcome.ts — the list lives in code,
--                      deliberately not in a CHECK, so a new reason doesn't
--                      need a migration)
--   drip_enrol_at      when that outcome was recorded
--
-- ── WHAT WAITS ON THIS ─────────────────────────────────────────────────
-- The code SHIPS BEFORE THIS RUNS and is written for the columns to be
-- absent: the write is skipped with a console warning, the reads error and
-- fall back. Until it runs:
--   · the client card keeps its OLD inference (only "location not live" and
--     "arrived before the location went live" can be named) — the new
--     per-cause wording needs the stored reason
--   · the ops alert for a broken sequence has nothing to read and stays quiet
--   · the Timeline entry for a setup/system cause still writes, but can't
--     de-duplicate, so a repeated Activate may add a second entry
-- What works WITHOUT it: the New sheet's "nurture emails didn't start"
-- warning and the Activate toast (both use the live result), enrolment from
-- the lowest step, and renumbering on save.
--
-- ── READ-ONLY DRY ANALYSIS (run 2026-09-27, production) ────────────────
--   leads.drip_enrol_reason / drip_enrol_at exist? ...... NO
--   leads created in the last 30 days with no drip row,
--     at ACTIVE locations, that should have enrolled .... 22
--       14 arrived before their location went live
--        7 hand-entered with Drip (most likely) unticked
--        1 Test Fornat — Test Location's Moving copy has only a step 3
--   Every existing lead lands NULL here — i.e. "no recorded reason", which
--   the card treats exactly as it does today. Nothing is backfilled.

alter table public.leads
  add column if not exists drip_enrol_reason text,
  add column if not exists drip_enrol_at timestamptz;

-- The failure-alert job reads recent setup failures every ~5 minutes.
create index if not exists leads_drip_enrol_reason_at_idx
  on public.leads (drip_enrol_reason, drip_enrol_at)
  where drip_enrol_reason is not null;

-- ── VERIFY ─────────────────────────────────────────────────────────────
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='leads'
--    and column_name in ('drip_enrol_reason','drip_enrol_at');
--   → 2 rows
