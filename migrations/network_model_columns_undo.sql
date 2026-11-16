-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/network_model_columns_undo.sql — undo network_model_columns.sql
-- (and, with it, network_model_backfill.sql)
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN on production. Run on a copy 2026-11-15: the table
-- came back to the same 31 columns and the same fingerprint it started with.
-- Safe to run twice.
--
-- READ THIS FIRST. This drops the five new columns, and everything in them
-- goes too: the types, levels and stages the backfill filled in, and, once
-- the new Network screen is open, every type, level, stage and birthday an
-- owner has set by hand since. Before Network is un-greyed that is nothing
-- anyone typed, and the backfill can simply be run again. After it, it is
-- owners' work.
--
-- It touches no other column and no other table. To blank the backfill and
-- keep the columns, run migrations/network_model_backfill_undo.sql instead.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.partners drop constraint if exists partners_birthday_reminder_check;
alter table public.partners drop constraint if exists partners_birthday_check;
alter table public.partners drop constraint if exists partners_partner_stage_check;
alter table public.partners drop constraint if exists partners_partner_level_check;
alter table public.partners drop constraint if exists partners_network_types_check;

alter table public.partners drop column if exists birthday_reminder;
alter table public.partners drop column if exists birthday;
alter table public.partners drop column if exists partner_stage;
alter table public.partners drop column if exists partner_level;
alter table public.partners drop column if exists network_types;
