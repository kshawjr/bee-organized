-- HELD ARTIFACT — Kevin runs this by hand. Nothing in the app runs it.
--
-- What it repairs (3 Sept 2026): five Request engagements the webform intake
-- founded on a FRESH lead's second form submission, before the fresh-lead
-- guard (app/api/leads/intake/route.ts) existed. Each one turned a never-called
-- new lead Active and hid them from the Inbox, the badge and the Home tile.
-- None of the five has a quote, job, assessment, service request, invoice or
-- note attached (verified read-only 3 Sept 2026). Christina Van Houten's
-- (Katy, abaa341c) is deliberately NOT here: hers became real work — three
-- quotes, a job and an invoice, now Final Processing.
--
-- After this runs the five leads read exactly as a lead nobody has called:
--   Jane Cater (NW Arkansas, 9 Aug)   → New until 8 Sept, then Nurturing
--   Rachel Sampeck (Dallas, 17 Aug)   → New until 16 Sept, then Nurturing
--   kelly Hardy (Philly Suburbs, 2 Sep) → New
--   Laney Waterman (Kansas City, 3 Sep) → Attempting (reach-out logged 3 Sep)
--   Ashley Devoto (NoVA, 27 Jul)      → Nurturing NOW: 38 days old, no reach-out.
--     The software cannot resurface her; someone has to call her. NoVA had no
--     resolvable owner when she arrived ("assignment_no_owner" on both intake
--     log lines) — hand her to whoever covers NoVA.
-- Their "Back again" chips disappear with the engagement (the roll-up needs an
-- open engagement to anchor to), which is correct: they are not returning.
--
-- FK rules on engagements: touchpoints/quotes/jobs/... are NO ACTION, so the
-- pointing rows must be released first; engagement_assignees cascades.
--
-- STEP 1 — DRY RUN (read-only). Expect exactly 5 engagements, 6 touchpoints
-- (Laney has a reach-out anchored too), 3 assignee rows, 0 anything else.
with phantom(id) as (values
  ('6d769a6f-a840-4cee-bebf-c0f7d66f6d59'::uuid), -- Ashley Devoto
  ('8b2ef8d2-9e8c-4948-a35a-9509a1c2d0c5'::uuid), -- Jane Cater
  ('01714d69-2499-41c3-8929-082e4f9b6d54'::uuid), -- Rachel Sampeck
  ('d8c2bcb9-85b5-4feb-a14a-23e303bddc60'::uuid), -- kelly Hardy
  ('a57aec9f-4061-4914-ac04-138114766dca'::uuid)  -- Laney Waterman
)
select 'engagement' as what, count(*) from engagements e join phantom p on p.id = e.id
  where e.stage = 'Request' and e.founded_by = 'manual'
union all select 'touchpoints to release', count(*) from touchpoints t join phantom p on p.id = t.engagement_id
union all select 'assignees (cascade)', count(*) from engagement_assignees a join phantom p on p.id = a.engagement_id
union all select 'quotes (must be 0)', count(*) from quotes q join phantom p on p.id = q.engagement_id
union all select 'jobs (must be 0)', count(*) from jobs j join phantom p on p.id = j.engagement_id
union all select 'assessments (must be 0)', count(*) from assessments a join phantom p on p.id = a.engagement_id
union all select 'service_requests (must be 0)', count(*) from service_requests s join phantom p on p.id = s.engagement_id
union all select 'invoices (must be 0)', count(*) from invoices i join phantom p on p.id = i.engagement_id
union all select 'lead_notes (must be 0)', count(*) from lead_notes n join phantom p on p.id = n.engagement_id;

-- STEP 2 — THE REPAIR. Run only after step 1 shows 5 / 6 / 3 / 0 / 0 / 0 / 0 / 0 / 0.
-- Wrapped in a transaction; the final select must show 0 engagements left.
-- begin;
-- with phantom(id) as (values
--   ('6d769a6f-a840-4cee-bebf-c0f7d66f6d59'::uuid),
--   ('8b2ef8d2-9e8c-4948-a35a-9509a1c2d0c5'::uuid),
--   ('01714d69-2499-41c3-8929-082e4f9b6d54'::uuid),
--   ('d8c2bcb9-85b5-4feb-a14a-23e303bddc60'::uuid),
--   ('a57aec9f-4061-4914-ac04-138114766dca'::uuid)
-- )
-- update touchpoints t set engagement_id = null from phantom p where p.id = t.engagement_id;
-- delete from engagements e
--   where e.id in ('6d769a6f-a840-4cee-bebf-c0f7d66f6d59','8b2ef8d2-9e8c-4948-a35a-9509a1c2d0c5','01714d69-2499-41c3-8929-082e4f9b6d54','d8c2bcb9-85b5-4feb-a14a-23e303bddc60','a57aec9f-4061-4914-ac04-138114766dca')
--   and e.stage = 'Request' and e.founded_by = 'manual';
-- select count(*) as engagements_left from engagements
--   where id in ('6d769a6f-a840-4cee-bebf-c0f7d66f6d59','8b2ef8d2-9e8c-4948-a35a-9509a1c2d0c5','01714d69-2499-41c3-8929-082e4f9b6d54','d8c2bcb9-85b5-4feb-a14a-23e303bddc60','a57aec9f-4061-4914-ac04-138114766dca');
-- commit;
