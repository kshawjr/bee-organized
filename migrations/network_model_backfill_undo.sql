-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/network_model_backfill_undo.sql — undo network_model_backfill.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN on production. Run on a copy 2026-11-15: the three
-- columns came back empty and every other column was untouched. Safe to run
-- twice.
--
-- READ THIS FIRST. This empties network_types, partner_level and
-- partner_stage on EVERY contact, not only the ones the backfill filled.
-- While Network is closed those are the same thing: nothing else writes
-- these columns. Once the new Network screen is open they are not, and this
-- would wipe every type, level and stage an owner has set by hand. Do not run
-- it after Network is un-greyed.
--
-- The columns stay. Birthdays are not touched. No other column and no other
-- table is written. The backfill can be run again afterwards.
-- ═══════════════════════════════════════════════════════════════════════════

update public.partners
set network_types = null,
    partner_level = null,
    partner_stage = null
where network_types is not null
   or partner_level is not null
   or partner_stage is not null;
