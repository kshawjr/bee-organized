-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/network_model_check.sql — Network & Nurture, slice 2 of 9
-- READ-ONLY. One SELECT. Changes nothing. Run it as often as you like.
-- ═══════════════════════════════════════════════════════════════════════════
-- Run it three times: before network_model_columns.sql, after it, and after
-- network_model_backfill.sql. It works whether or not the new columns exist.
--
-- WHAT TO LOOK FOR
--   01, 02  the row counts. They must be the same all three times (unless a
--           contact was really added or removed in between).
--   03      THE FINGERPRINT of every column the table has today, over every
--           row. It must be the same all three times. If it is, no old
--           column on any row changed by so much as a character.
--   04      whether the five new columns are there yet.
--   05–09   what the backfill WOULD give the live contacts, worked out now.
--   10      the same working-out as one fingerprint, to hold against the
--           TypeScript rules (scripts/network-model-dry-run.mjs prints its
--           own; the two must match).
--   11–13   what the new columns hold right now. Before the backfill: 0
--           filled. Straight after it: every row filled and 0 that differ
--           from the rules. (Once owners start changing types on the new
--           screen, 13 will rightly stop being 0.)
--
-- The MAPPING block below is the same text as the one in
-- network_model_backfill.sql. lib/network/model-migration.test.ts fails if
-- the two ever differ.
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
                 where l.referred_by_kind = 'partner' and l.referred_by_id = p.id) as sent_lead
  from public.partners p
),
ruled as (
  select f.*,
         (f.tier in ('referral-partner', 'power-partner') or f.tag_referral or f.sent_lead) as is_referral,
         (f.tier = 'service-provider' or f.tag_vendor) as is_vendor
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
, rows_now as (
  select p.id,
         (p.deleted_at is null) as live,
         -- The 31 columns the table has today, in their own order. Times are
         -- read as seconds so the answer does not depend on a time zone.
         md5(row(
           p.id, p.location_id, p.type, p.name, p.email, p.phone, p.company_id, p.stage,
           p.specialties, p.tier, p.tags, p.addresses, p.notes, p.next_steps, p.referrals,
           p.activity, extract(epoch from p.deleted_at), extract(epoch from p.created_at),
           extract(epoch from p.updated_at), p.created_by, p.title, p.company, p.website,
           p.how_we_met, p.met_date, p.last_contact, p.is_customer, p.relationship,
           p.card_image, p.customer_lead_id, extract(epoch from p.last_contacted_at)
         )::text) as old_fp,
         -- The new columns, read in a way that works before they exist.
         to_jsonb(p) ? 'network_types' as has_new,
         to_jsonb(p) -> 'network_types' as st_types,
         to_jsonb(p) ->> 'partner_level' as st_level,
         to_jsonb(p) ->> 'partner_stage' as st_stage,
         m.network_types, m.partner_level, m.partner_stage
  from public.partners p
  join mapped m on m.id = p.id
)
select '01 contacts, live (deleted_at is null)' as what, count(*) filter (where live)::text as answer from rows_now
union all select '02 contacts, all (recycle bin included)', count(*)::text from rows_now
union all select '03 FINGERPRINT of the 31 existing columns, all rows',
       md5(string_agg(old_fp, '' order by id)) from rows_now
union all select '04 new columns present', coalesce(bool_and(has_new), false)::text from rows_now
union all select '05 would be Referral partner (live)',
       count(*) filter (where live and 'partner' = any (network_types))::text from rows_now
union all select '06 .. of those, also Vendor (live)',
       count(*) filter (where live and network_types = array['partner', 'vendor'])::text from rows_now
union all select '07 would be Vendor only (live)',
       count(*) filter (where live and network_types = array['vendor'])::text from rows_now
union all select '08 would be Not sure yet (live)',
       count(*) filter (where live and network_types = array['unsure'])::text from rows_now
union all select '09 would be mapped in the recycle bin',
       count(*) filter (where not live)::text from rows_now
union all select '10 FINGERPRINT of the mapping, all rows',
       md5(string_agg(id::text || '|' || array_to_string(network_types, '+') || '|'
                      || coalesce(partner_level, '') || '|' || coalesce(partner_stage, ''),
                      E'\n' order by id)) from rows_now
union all select '11 rows with a type filled in now',
       count(*) filter (where st_types is not null and st_types <> 'null'::jsonb)::text from rows_now
union all select '12 rows still empty now',
       count(*) filter (where st_types is null or st_types = 'null'::jsonb)::text from rows_now
union all select '13 filled rows that differ from the rules',
       count(*) filter (where st_types is not null and st_types <> 'null'::jsonb
                          and (st_types <> to_jsonb(network_types)
                               or st_level is distinct from partner_level
                               or st_stage is distinct from partner_stage))::text from rows_now
order by 1;
