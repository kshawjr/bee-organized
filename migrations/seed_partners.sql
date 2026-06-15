-- One-time seed: the former PARTNERS_DATA / COMPANIES_DATA mock records as real
-- rows, for the TEST LOCATION ONLY (a8fe17f6-fd16-4ed3-8730-550a65d69ad6), so
-- demos that referenced these partners keep working after the mock arrays were
-- removed. The mock data spanned KC/Scottsdale/Omaha; we collapse all of it onto
-- Test Location intentionally — do NOT fan this out across real locations.
--
-- Run AFTER migrations/partners.sql. Safe to re-run: explicit uuids +
-- ON CONFLICT (id) DO NOTHING. company_id is a soft ref (no FK); the explicit
-- company uuids below are what the partner rows point at.

-- ─── Companies ──────────────────────────────────────────────────────────────
INSERT INTO public.companies (id, location_id, name, industry, phone, email, website, notes, activity) VALUES
  ('c0000001-0000-4000-8000-000000000001', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'Meridian Realty',        'Real Estate',        '(816) 555-0900', 'info@meridianrealty.com',   'meridianrealty.com',  '[{"id":"n1","text":"Largest referral source - 3 active agents referring clients","ts":"Jan 2025","user":"You"}]'::jsonb, '[{"type":"event","label":"Added as Company","ts":"Nov 2024"}]'::jsonb),
  ('c0000002-0000-4000-8000-000000000002', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'ABC Moving & Storage',   'Moving Services',    '(816) 555-0441', 'partners@abcmoving.com',     'abcmoving.com',       '[{"id":"n1","text":"Refer us to every move-in - great pipeline for organization jobs","ts":"Mar 2025","user":"You"}]'::jsonb, '[{"type":"event","label":"Added as Company","ts":"Mar 2025"}]'::jsonb),
  ('c0000003-0000-4000-8000-000000000003', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'Walsh Construction',     'General Contractor', '(816) 555-0830', 'info@walshconstruction.com', 'walshconstruction.com', '[{"id":"n1","text":"High-end remodels - clients always need post-reno organizing","ts":"Apr 2025","user":"You"}]'::jsonb, '[{"type":"event","label":"Added as Company","ts":"Apr 2025"}]'::jsonb),
  ('c0000004-0000-4000-8000-000000000004', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'Reyes Interior Design',  'Interior Design',    '(480) 555-0578', 'sofia@reyesdesign.com',      'reyesdesign.com',     '[{"id":"n1","text":"Co-market opportunity - her clients love organized spaces","ts":"Mar 2025","user":"You"}]'::jsonb, '[{"type":"event","label":"Added as Company","ts":"Mar 2025"}]'::jsonb),
  ('c0000005-0000-4000-8000-000000000005', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'Boulder Property Group', 'Property Management', '(480) 555-0192', 'info@boulderpg.com',         'boulderpg.com',       '[{"id":"n1","text":"Manages 40+ properties - huge opportunity","ts":"May 2025","user":"You"}]'::jsonb, '[{"type":"event","label":"Added as Company","ts":"May 2025"}]'::jsonb),
  ('c0000006-0000-4000-8000-000000000006', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'Heartland Staging Co.',  'Home Staging',       '(402) 555-0310', 'hello@heartlandstaging.com', 'heartlandstaging.com', '[{"id":"n1","text":"Stager + organizer combo - lots of shared clients","ts":"Apr 2025","user":"You"}]'::jsonb, '[{"type":"event","label":"Added as Company","ts":"Apr 2025"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ─── Partners + Contacts ──────────────────────────────────────────────────────
INSERT INTO public.partners
  (id, location_id, type, name, title, company, company_id, phone, email, website, stage, specialties, tier, tags, how_we_met, met_date, last_contact, is_customer, customer_lead_id, relationship, notes, next_steps, referrals, activity)
VALUES
  ('a0000001-0000-4000-8000-000000000001', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'partner', 'Karen Martinez',  'Real Estate Agent',   'Meridian Realty',        'c0000001-0000-4000-8000-000000000001', '(816) 555-0916', 'kmartinez@meridianrealty.com', 'meridianrealty.com', 'Active Partner', '{real-estate}', NULL, '{top-referrer,vip}', 'Denver Business Expo', 'Nov 2024', 'Apr 28', false, NULL, NULL,
    '[{"id":"n1","text":"Met at her open house - very enthusiastic about home organization for listings","ts":"Nov 2024","user":"You"},{"id":"n2","text":"Prefers text over calls. Send holiday gift every year - loves Teak & Twine.","ts":"Jan 2025","user":"You"}]'::jsonb,
    '[{"id":"ns1","text":"Send Q2 referral thank-you gift","date":"2026-05-15","done":false,"createdAt":"May 7"},{"id":"ns2","text":"Schedule lunch to discuss summer listing pipeline","date":"2026-05-22","done":false,"createdAt":"May 7"}]'::jsonb,
    '[{"leadId":"3","name":"Lisa Patel","date":"Apr 20","converted":true,"revenue":0},{"leadId":"r3","name":"Claire Davidson","date":"Mar 22","converted":false,"revenue":0}]'::jsonb,
    '[{"type":"event","label":"Met at Denver Business Expo","ts":"Nov 2024"},{"type":"referral","label":"Sent Lisa Patel our way","ts":"Apr 20","user":"Karen"},{"type":"call","label":"Quarterly check-in call - great energy","ts":"Apr 28","user":"You"}]'::jsonb),
  ('a0000006-0000-4000-8000-000000000006', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'partner', 'Tony Reyes',      'Operations Manager',  'ABC Moving & Storage',   'c0000002-0000-4000-8000-000000000002', '(816) 555-0551', 'tony@abcmoving.com',          'abcmoving.com',      'Active Partner', '{moving}', NULL, '{top-referrer}', 'Chamber of Commerce mixer', 'Mar 2025', 'Apr 20', false, NULL, NULL,
    '[{"id":"n1","text":"Primary contact at ABC - handles all partner referrals personally","ts":"Mar 2025","user":"You"}]'::jsonb,
    '[{"id":"ns1","text":"Send referral thank-you cards for April leads","date":"2026-05-15","done":false,"createdAt":"May 7"}]'::jsonb,
    '[{"leadId":"johnson1","name":"Mark Johnson","date":"Apr 5","converted":false,"revenue":0},{"leadId":"qc1","name":"David Park","date":"Apr 18","converted":false,"revenue":0}]'::jsonb,
    '[{"type":"event","label":"Met at Chamber of Commerce mixer","ts":"Mar 2025"},{"type":"referral","label":"Sent Mark Johnson - move-in job","ts":"Apr 5","user":"Tony"}]'::jsonb),
  ('a0000002-0000-4000-8000-000000000002', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'partner', 'James Whitfield', 'Project Manager',     'Walsh Construction',     'c0000003-0000-4000-8000-000000000003', '(816) 555-0341', 'james@walshconstruction.com', 'walshconstruction.com', 'Building', '{contractor}', NULL, '{high-potential}', 'Referral from Karen Martinez', 'Feb 2025', 'Apr 15', false, NULL, NULL,
    '[{"id":"n1","text":"Manages high-end remodels - clients always need organizing after. Great fit.","ts":"Feb 2025","user":"You"}]'::jsonb,
    '[{"id":"ns1","text":"Follow up on Diana Walsh project outcome","date":"2026-05-20","done":false,"createdAt":"May 1"}]'::jsonb,
    '[{"leadId":"r4","name":"Diana Walsh","date":"Apr 15","converted":true,"revenue":0}]'::jsonb,
    '[{"type":"call","label":"Intro call - Karen connected us","ts":"Feb 2025"},{"type":"referral","label":"Sent Diana Walsh - garage after remodel","ts":"Apr 15","user":"James"}]'::jsonb),
  ('a0000007-0000-4000-8000-000000000007', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'partner', 'Sandra Park',     'Residential Sales Rep', 'ABC Moving & Storage',  'c0000002-0000-4000-8000-000000000002', '(816) 555-0662', 'spark@abcmoving.com',         'abcmoving.com',      'New Contact', '{moving}', NULL, '{}', 'Intro from Tony Reyes', 'Apr 20', 'Apr 20', false, NULL, NULL,
    '[{"id":"n1","text":"Handles residential moves - Tony connected us. Following up.","ts":"Apr 20","user":"You"}]'::jsonb,
    '[]'::jsonb, '[]'::jsonb,
    '[{"type":"event","label":"Intro from Tony Reyes","ts":"Apr 20"}]'::jsonb),
  ('b0000001-0000-4000-8000-000000000001', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'contact', 'Derek Walsh',     'Site Manager',        'Walsh Construction',     'c0000003-0000-4000-8000-000000000003', '(816) 555-0823', 'derek@walshconstruction.com', 'walshconstruction.com', 'Contact', '{}', NULL, '{}', 'Home show - chatted at the tradeshow booth', 'Apr 10', 'Apr 10', false, NULL, 'Vendor',
    '[{"id":"n1","text":"Works the job sites - good ground-level relationship to maintain","ts":"Apr 10","user":"You"}]'::jsonb,
    '[]'::jsonb, '[]'::jsonb,
    '[{"type":"event","label":"Added as Contact - Home show","ts":"Apr 10"}]'::jsonb),
  ('b0000002-0000-4000-8000-000000000002', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'contact', 'Marco Diaz',      'Crew Lead',           'ABC Moving & Storage',   'c0000002-0000-4000-8000-000000000002', '(816) 555-0773', 'marco@abcmoving.com',         'abcmoving.com',      'Contact', '{}', NULL, '{}', 'Met on a move-in job at Birchwood Dr', 'Apr 25', 'Apr 25', false, NULL, 'Vendor',
    '[{"id":"n1","text":"On the ground crew - friendly, talks to new homeowners. Good word of mouth.","ts":"Apr 25","user":"You"}]'::jsonb,
    '[]'::jsonb, '[]'::jsonb,
    '[{"type":"event","label":"Added as Contact - met on job site","ts":"Apr 25"}]'::jsonb),
  ('a0000003-0000-4000-8000-000000000003', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'partner', 'Sofia Reyes',     'Principal Designer',  'Reyes Interior Design',  'c0000004-0000-4000-8000-000000000004', '(480) 555-0578', 'sofia@reyesdesign.com',       'reyesdesign.com',    'Reaching Out', '{interior-designer}', NULL, '{co-market}', 'Cherry Creek Art Festival', 'Mar 2025', 'Mar 30', false, NULL, NULL,
    '[{"id":"n1","text":"Loves our concept - working on a formal referral agreement","ts":"Mar 2025","user":"You"}]'::jsonb,
    '[{"id":"ns1","text":"Send co-marketing proposal","date":"2026-05-20","done":false,"createdAt":"May 1"}]'::jsonb,
    '[]'::jsonb,
    '[{"type":"event","label":"Met at Cherry Creek Art Festival","ts":"Mar 2025"},{"type":"email","label":"Sent intro email with services overview","ts":"Mar 30","user":"You"}]'::jsonb),
  ('a0000004-0000-4000-8000-000000000004', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'partner', 'Tom Briggs',      'Property Manager',    'Boulder Property Group', 'c0000005-0000-4000-8000-000000000005', '(480) 555-0192', 'tom@boulderpg.com',           'boulderpg.com',      'New Contact', '{property-manager}', NULL, '{}', 'Chamber of Commerce mixer', 'May 2025', 'May 2025', false, NULL, NULL,
    '[{"id":"n1","text":"Manages 40+ properties - massive opportunity if he refers even 10%","ts":"May 2025","user":"You"}]'::jsonb,
    '[{"id":"ns1","text":"Send info packet + pricing for multi-unit clients","date":"2026-05-12","done":false,"createdAt":"May 1"}]'::jsonb,
    '[]'::jsonb,
    '[{"type":"event","label":"Met at Chamber of Commerce mixer","ts":"May 2025"}]'::jsonb),
  ('a0000008-0000-4000-8000-000000000008', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'partner', 'Maria Cruz',      'Property Manager',    'Denver Realty Group',    NULL, '(720) 555-0109', 'mcruz@propmanage.com',        'denverrealtygroup.com', 'Active Partner', '{property-management,real-estate}', NULL, '{}', 'Lisa Patel referral', 'Feb 2025', 'Apr 20', false, NULL, NULL,
    '[{"id":"n1","text":"Manages several properties in the Cherry Creek area - good source of move-in referrals","ts":"Feb 2025","user":"You"}]'::jsonb,
    '[]'::jsonb, '[]'::jsonb,
    '[{"type":"intro","label":"Introduction via Lisa Patel","ts":"Feb 2025"},{"type":"meeting","label":"Coffee meeting - discussed referral arrangement","ts":"Mar 2025","user":"You"}]'::jsonb),
  ('a0000005-0000-4000-8000-000000000005', 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', 'partner', 'Rachel Kim',      'Lead Stager & Owner', 'Heartland Staging Co.',  'c0000006-0000-4000-8000-000000000006', '(402) 555-0498', 'rkim@heartlandstaging.com',   'heartlandstaging.com', 'Active Partner', '{stager}', NULL, '{top-referrer}', 'Omaha REALTOR Expo', 'Apr 2025', 'Apr 28', true, '4', NULL,
    '[{"id":"n1","text":"Was also a client - loved the closet work. Now refers every staging client.","ts":"Apr 28","user":"You"}]'::jsonb,
    '[]'::jsonb,
    '[{"leadId":"r5","name":"Amanda Chen","date":"Apr 28","converted":false,"revenue":0}]'::jsonb,
    '[{"type":"event","label":"Met at Omaha REALTOR Expo","ts":"Apr 2025"},{"type":"referral","label":"Referred Amanda Chen - new listing","ts":"Apr 28","user":"Rachel"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;
