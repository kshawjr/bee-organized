-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/network_types_fix_26.sql — the 26 contacts made after the backfill
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: RUN by Kevin 2026-11-19; verified in production (308 live contacts, 0 with no type). Safe to run twice: the second run
-- changes 0 rows (it only fills rows whose network_types is still empty).
--
-- WHAT. The 26 live contacts owners made between 16 and 19 Nov 2026, after
-- the slice 2 backfill ran, through doors that do not set network_types
-- (the old Network screen in an open tab; a client's "Referred by" Create
-- partner; a client's Add to Network). They get network_types, and for a
-- Referral partner a level and stage, by EXACTLY the slice 2 mapping: the
-- block between MAPPING BEGIN and MAPPING END below is a byte-for-byte copy
-- of migrations/network_model_backfill.sql's (Kevin's slice 1 rulings;
-- lib/network/network-types-fix-26.test.ts holds the two together).
-- Nothing new is decided here.
--
-- WHICH ROWS. Only these 26, by id, and only while still empty. A contact
-- made after this was written is NOT touched (that is the door question,
-- not this fix).
--
-- WHAT IT WRITES. network_types, partner_level, partner_stage. Nothing else:
-- not type, stage, tier, updated_at, name. public.partners has no trigger.
--
-- READ THE REPORT FIRST, every one of the 26 by name with what it gets:
--   ~/Projects/bee-organized-repair-reports/2026-11-19/network-types-fix-26.md
--
-- ONE STATEMENT (the Supabase editor forgets temp tables).
-- UNDO: migrations/network_types_fix_26_undo.sql
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
  and p.network_types is null
  and p.id in ('b7debef2-d4fa-49a9-99ff-6f259bc4a216',
                 '010e9e83-2c5b-4044-bc2b-54d9761b8dad',
                 '4bc3ef53-07ae-44eb-90e9-34058ae15c4e',
                 '135ac3b5-98bf-4492-b982-12f14593b14c',
                 '97ebcc67-c630-42ae-9677-d35971fbae1a',
                 'afc562ba-4c3e-44f3-ac8f-f8af8ed20870',
                 'cf6ef09b-c580-4bc6-a728-9a1bfd3427a3',
                 'e14d2091-6a43-48d9-a820-00eeb837a03b',
                 'c77409ca-dee0-4083-bafb-94b287b3ecf5',
                 '7bfc6557-aecb-4bf7-b357-81cf9ca11c92',
                 '90197509-e28e-420b-8c44-748cbf7a12b0',
                 '60650994-621c-4662-ab79-1c394181617c',
                 'e55f3c03-d445-4b1c-9a56-096b09e471af',
                 'a9ee8586-e484-43d9-b761-9e40c821c9fd',
                 'eb6c048f-3b44-4709-b713-080392334f27',
                 'c2f74d3b-e61b-4247-a235-4795196d73f1',
                 '5f0354a1-4e98-480b-bd21-09b7bc67499b',
                 '367d11b7-cd47-47a5-a4cf-59d520421ef8',
                 'a87178ec-08c7-4fd0-b254-5399efc556fd',
                 'a3c68900-80e4-4f35-8471-b6b1424d9104',
                 '8eb6d133-03c8-4799-aa7d-aebdd27b84bf',
                 '3d078c05-261e-4e1d-9f91-4bdf1a175959',
                 '38f2c43d-a0b0-4009-8e1d-4ffdbc05588c',
                 '0e6ff891-412b-4506-ae8e-7356ba1a29d0',
                 '6d9063b3-f631-4717-abcf-9f94422b3e23',
                 '217f5626-d479-439a-b1bd-29e96c246c89');
