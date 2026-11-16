-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/network_model_columns.sql — Network & Nurture, slice 2 of 9
-- STEP 1 OF 2: somewhere to put the new model. Adds columns; changes no row.
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN. Kevin runs it. Safe to run twice.
--
-- RUN ORDER
--   0. migrations/network_model_check.sql      (read-only; note the numbers)
--   1. THIS FILE
--   2. migrations/network_model_check.sql      (the fingerprint must not move)
--   3. migrations/network_model_backfill.sql
--   4. migrations/network_model_check.sql      (the fingerprint must not move)
--
-- WHAT IT DOES. Five new columns on public.partners, all of them empty when
-- this finishes:
--
--   network_types      text[]   the contact's types; more than one allowed.
--                               Words: partner, vendor, nurture, organization,
--                               unsure (lib/network/types.ts NET_TYPES).
--                               NULL = nobody has decided yet, which every
--                               reader shows as "Not sure yet".
--   partner_level      text     Referral partners only: potential, referral,
--                               power.
--   partner_stage      text     Referral partners only: New Contact, Reaching
--                               Out, Building the Relationship, Active
--                               Partner, Gone quiet.
--   birthday           text     month and day, like 'Mar 22'. Never a year.
--   birthday_reminder  boolean  remind the owner; only with a birthday.
--
-- WHAT IT DOES NOT DO. Nothing is dropped, nothing is renamed and no existing
-- column is altered. type, stage, tier, addresses, website, how_we_met,
-- met_date and every other column stay exactly where they are, holding
-- exactly what they hold now. The old `stage` and `tier` are NOT the new
-- `partner_stage` and `partner_level`: they are different columns, and the
-- old ones keep their old words.
--
-- NO "potential partner" COLUMN. Potential is the first of the three levels
-- (Kevin's ruling), so it is a value of partner_level. A second yes/no column
-- saying the same thing could disagree with it.
--
-- THE APP DOES NOT READ THESE YET. Every partners read names its columns
-- (lib/crm.ts PARTNER_COLS) and none of the five is on that list, so the code
-- that is live today behaves the same before and after this runs. Network
-- stays closed.
--
-- THE RULES ARE IN THE TABLE, not only in the code, so a bad value cannot be
-- saved by any door:
--   · a type must be one of the five words
--   · a level or a stage must be one of ours
--   · only a Referral partner may have a level or a stage
--   · a birthday must read like 'Mar 22'; a reminder needs a birthday
-- Every one of them passes on an empty column, so adding them cannot fail on
-- the rows that exist.
--
-- UNDO: migrations/network_model_columns_undo.sql
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.partners add column if not exists network_types text[];
alter table public.partners add column if not exists partner_level text;
alter table public.partners add column if not exists partner_stage text;
alter table public.partners add column if not exists birthday text;
alter table public.partners add column if not exists birthday_reminder boolean not null default false;

-- Each rule is taken off and put back, so a second run leaves exactly one.
alter table public.partners drop constraint if exists partners_network_types_check;
alter table public.partners add constraint partners_network_types_check
  check (
    network_types is null
    or (cardinality(network_types) >= 1
        and network_types <@ array['partner', 'vendor', 'nurture', 'organization', 'unsure']::text[])
  );

alter table public.partners drop constraint if exists partners_partner_level_check;
alter table public.partners add constraint partners_partner_level_check
  check (
    partner_level is null
    or (partner_level in ('potential', 'referral', 'power')
        and network_types is not null and 'partner' = any (network_types))
  );

alter table public.partners drop constraint if exists partners_partner_stage_check;
alter table public.partners add constraint partners_partner_stage_check
  check (
    partner_stage is null
    or (partner_stage in ('New Contact', 'Reaching Out', 'Building the Relationship', 'Active Partner', 'Gone quiet')
        and network_types is not null and 'partner' = any (network_types))
  );

alter table public.partners drop constraint if exists partners_birthday_check;
alter table public.partners add constraint partners_birthday_check
  check (
    birthday is null
    or birthday ~ '^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01])$'
  );

alter table public.partners drop constraint if exists partners_birthday_reminder_check;
alter table public.partners add constraint partners_birthday_reminder_check
  check (birthday_reminder = false or birthday is not null);
