-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/network_model_backfill.sql — Network & Nurture, slice 2 of 9
-- STEP 2 OF 2: put every existing Network contact on the new model.
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN. Kevin runs it, after network_model_columns.sql.
-- Safe to run twice: the second run changes 0 rows.
--
-- READ THE REPORT FIRST. Every contact, by name, with what it holds now and
-- what this would give it:
--   ~/Projects/bee-organized-repair-reports/2026-11-15/network-model-dry-run.md
--
-- ONE STATEMENT, on purpose. The Supabase editor forgets a temporary table
-- between statements, so the working-out is done inside the one UPDATE.
--
-- WHAT IT WRITES. Three columns, on public.partners, and nothing else:
--   network_types, partner_level, partner_stage
-- It does not touch type, stage, tier, updated_at or any other existing
-- column, and it writes to no other table. public.partners has no trigger,
-- so nothing else is written behind it either.
--
-- WHICH ROWS. Every row whose network_types is still empty. That is what
-- makes a second run do nothing, and it is also why this can never overwrite
-- a type an owner has chosen: once a row has a type, this leaves it alone.
-- Contacts in the recycle bin are mapped too, so one that is restored later
-- comes back as what it was, not as "Not sure yet".
--
-- KEVIN'S RULES (2026-11-15). The same rules as lib/network/live-mapping.ts,
-- written a second time here because the database cannot run TypeScript. The
-- two were run over every row in production and gave the same answer on all
-- of them; lib/network/model-migration.test.ts holds them together.
--
--   1. Tier Referral Partner or Power Partner, OR tagged Partner / Referral,
--      OR a client's "referred by" points at them:
--        Referral partner. Level Referral Partner (Power Partner if the tier
--        says so). The live stage carries across; Dormant becomes Gone quiet;
--        a blank or unknown stage starts at New Contact.
--   2. Tier Service Provider, OR tagged Vendor:
--        Vendor / Service Provider. No level, no stage.
--      A contact who meets 1 and 2 holds both types.
--   3. Everything else, Networking Contact included: Not sure yet. No level,
--      no stage. A trade tag (Realtor, Mover…) is never used to guess.
--   4. Four contacts Kevin ruled on by name are Not sure yet whatever 1 and
--      2 say. Each counted as a Referral partner only because one client's
--      "referred by" points at it, and none is one. They are held by id
--      below (the same four ids as RULED_NOT_SURE_IDS in the TypeScript);
--      their names are in the dry-run report.
--
-- UNDO: migrations/network_model_backfill_undo.sql (blanks the three columns)
-- ═══════════════════════════════════════════════════════════════════════════

with
-- MAPPING BEGIN
facts as (
  select p.id,
         regexp_replace(lower(btrim(coalesce(p.tier, ''), E' \t\r\n')), '[[:space:]_]+', '-', 'g') as tier,
         regexp_replace(lower(btrim(coalesce(p.stage, ''), E' \t\r\n')), '[[:space:]]+', ' ', 'g') as stage,
         exists (select 1 from public.partner_tags pt
                 join public.lookups lk on lk.id = pt.tag_lookup_id
                 where pt.partner_id = p.id
                   and lower(btrim(lk.label, E' \t\r\n')) in ('partner', 'referral')) as tag_referral,
         exists (select 1 from public.partner_tags pt
                 join public.lookups lk on lk.id = pt.tag_lookup_id
                 where pt.partner_id = p.id
                   and lower(btrim(lk.label, E' \t\r\n')) = 'vendor') as tag_vendor,
         exists (select 1 from public.leads l
                 where l.referred_by_kind = 'partner' and l.referred_by_id = p.id) as sent_lead,
         p.id in ('0988e56f-ee8b-4ca1-804b-8733e9e0f797',
                  '2700f38b-cea1-4878-ace9-58b5737612e3',
                  '32ab75f7-daf6-4dc0-884b-8c3b6129776a',
                  'ee138794-65e1-4146-bc79-f334a79d822c') as ruled_not_sure
  from public.partners p
),
ruled as (
  select f.*,
         (not f.ruled_not_sure
          and (f.tier in ('referral-partner', 'power-partner') or f.tag_referral or f.sent_lead)) as is_referral,
         (not f.ruled_not_sure
          and (f.tier = 'service-provider' or f.tag_vendor)) as is_vendor
  from facts f
),
mapped as (
  select r.id,
         case when r.is_referral and r.is_vendor then array['partner', 'vendor']
              when r.is_referral then array['partner']
              when r.is_vendor then array['vendor']
              else array['unsure'] end as network_types,
         case when r.is_referral
              then case when r.tier = 'power-partner' then 'power' else 'referral' end
         end as partner_level,
         case when r.is_referral
              then case r.stage
                     when 'new contact' then 'New Contact'
                     when 'reaching out' then 'Reaching Out'
                     when 'building the relationship' then 'Building the Relationship'
                     when 'building' then 'Building the Relationship'
                     when 'active partner' then 'Active Partner'
                     when 'gone quiet' then 'Gone quiet'
                     when 'dormant' then 'Gone quiet'
                     else 'New Contact' end
         end as partner_stage
  from ruled r
)
-- MAPPING END
update public.partners p
set network_types = m.network_types,
    partner_level = m.partner_level,
    partner_stage = m.partner_stage
from mapped m
where m.id = p.id
  and p.network_types is null;
