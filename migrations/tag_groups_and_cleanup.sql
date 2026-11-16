-- migrations/tag_groups_and_cleanup.sql
--
-- NOT A SCHEMA CHANGE. No table, column, rule or function is added or
-- altered. This file changes DATA only: tag settings, tag links, four tags
-- and one client note. Kevin's rulings, 2026-11-15.
--
-- WHAT IT DOES
--   1. GROUPS. Writes "group" and "shows_on" into the settings box (attrs) of
--      48 tags. Nothing else in the box is touched.
--        Client Status        shows on Clients and Nurture
--        Relationship         shows on Network (Referral: on both)
--        the seven trade groups   show on Network (their group is already stored)
--          Home & Property, Design & Staging, Cleaning, Moving & Hauling,
--          Senior Living, Valuables, Professional Services
--        General Contractor, Electrician and Handyman are in Home & Property,
--        not Professional Services (Kevin, 2026-11-16).
--   2. MERGE Business Networking Group (North Jersey) INTO Networking Group.
--      3 Network contacts get Networking Group; the North Jersey tag is deleted.
--   3. MERGE Builder INTO General Contractor. 1 Network contact gets General
--      Contractor. Builder is switched off, not deleted: it is one of the
--      corporate tags from the original merge, which the delete rule keeps.
--      Its settings box records what it was merged into.
--   4. DELETE Lead (Portland). 2 clients lose it.
--   5. DELETE business (Portland). 3 clients and 4 Network contacts lose it.
--   6. DELETE Oak & Key (Portland). The one client who carries it gets a note
--      saying "Oak & Key" first. They are not added to Network.
--   Applicant (Seattle) is kept, local, and placed in Professional Services.
--
-- EVERY DELETE goes through delete_tag_if_unused(), the database's own delete
-- (migrations/tag_delete.sql), so each deleted tag is copied whole into
-- tag_deletions first.
--
-- GUARDED. It is one block: it either does all of it or none of it. Before
-- changing anything it checks every tag by id AND name AND location, and that
-- exactly the people listed in the dry run carry each tag. If anything has
-- changed since the dry run it stops with a message and changes nothing.
--
-- RUN FIRST (read-only): migrations/tag_groups_and_cleanup_check.sql
-- HOW TO UNDO:           migrations/tag_groups_and_cleanup_undo.sql

DO $$
DECLARE
  n int;
  b text[];
  bng     uuid := 'a433ba77-dae7-46ae-96c2-296246d331cf';  -- Business Networking Group (North Jersey)
  ng      uuid := '77c7e6dd-ef20-4c88-a109-62f42c551f7e';  -- Networking Group (corporate)
  builder uuid := 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec';  -- Builder (corporate)
  gc      uuid := 'ab36bf57-7410-4dfd-998d-f86b09529d21';  -- General Contractor (corporate)
  lead_t  uuid := 'c02da184-5e25-4690-9e8e-27fd525ff2f5';  -- Lead (Portland)
  biz     uuid := 'b63db20f-ef18-4cc6-93e5-d6682ba10c73';  -- business (Portland)
  oak     uuid := '97b8901d-283b-4e8e-a316-f268f1e96bfe';  -- Oak & Key (Portland)
  oak_client uuid := '1aee24bc-5e99-4a94-87b2-f5515fdab2f7';  -- the one client who carries Oak & Key
BEGIN
  -- ── guards: every tag is still what the dry run saw ──
  IF NOT EXISTS (SELECT 1 FROM lookups l JOIN locations loc ON loc.id = l.location_id WHERE l.id = bng AND l.label = 'Business Networking Group' AND l.category = 'tags' AND l.is_active AND loc.name = 'North Jersey') THEN
    RAISE EXCEPTION 'STOPPED, nothing changed: the tag "Business Networking Group" is not what it was at the dry run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lookups l WHERE l.id = ng AND l.label = 'Networking Group' AND l.category = 'tags' AND l.is_active AND l.location_id IS NULL) THEN
    RAISE EXCEPTION 'STOPPED, nothing changed: the tag "Networking Group" is not what it was at the dry run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lookups l WHERE l.id = builder AND l.label = 'Builder' AND l.category = 'tags' AND l.is_active AND l.location_id IS NULL) THEN
    RAISE EXCEPTION 'STOPPED, nothing changed: the tag "Builder" is not what it was at the dry run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lookups l WHERE l.id = gc AND l.label = 'General Contractor' AND l.category = 'tags' AND l.is_active AND l.location_id IS NULL) THEN
    RAISE EXCEPTION 'STOPPED, nothing changed: the tag "General Contractor" is not what it was at the dry run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lookups l JOIN locations loc ON loc.id = l.location_id WHERE l.id = lead_t AND l.label = 'Lead' AND l.category = 'tags' AND l.is_active AND loc.name = 'Portland') THEN
    RAISE EXCEPTION 'STOPPED, nothing changed: the tag "Lead" is not what it was at the dry run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lookups l JOIN locations loc ON loc.id = l.location_id WHERE l.id = biz AND l.label = 'business' AND l.category = 'tags' AND l.is_active AND loc.name = 'Portland') THEN
    RAISE EXCEPTION 'STOPPED, nothing changed: the tag "business" is not what it was at the dry run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lookups l JOIN locations loc ON loc.id = l.location_id WHERE l.id = oak AND l.label = 'Oak & Key' AND l.category = 'tags' AND l.is_active AND loc.name = 'Portland') THEN
    RAISE EXCEPTION 'STOPPED, nothing changed: the tag "Oak & Key" is not what it was at the dry run';
  END IF;
  SELECT count(*) INTO n FROM lead_tags WHERE tag_lookup_id = bng;
  IF n <> 0 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Business Networking Group" is on % clients, the dry run saw 0', n; END IF;
  SELECT count(*) INTO n FROM partner_tags WHERE tag_lookup_id = bng;
  IF n <> 3 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Business Networking Group" is on % Network contacts, the dry run saw 3', n; END IF;
  SELECT count(*) INTO n FROM lead_tags WHERE tag_lookup_id = builder;
  IF n <> 0 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Builder" is on % clients, the dry run saw 0', n; END IF;
  SELECT count(*) INTO n FROM partner_tags WHERE tag_lookup_id = builder;
  IF n <> 1 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Builder" is on % Network contacts, the dry run saw 1', n; END IF;
  SELECT count(*) INTO n FROM lead_tags WHERE tag_lookup_id = lead_t;
  IF n <> 2 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Lead" is on % clients, the dry run saw 2', n; END IF;
  SELECT count(*) INTO n FROM partner_tags WHERE tag_lookup_id = lead_t;
  IF n <> 0 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Lead" is on % Network contacts, the dry run saw 0', n; END IF;
  SELECT count(*) INTO n FROM lead_tags WHERE tag_lookup_id = biz;
  IF n <> 3 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "business" is on % clients, the dry run saw 3', n; END IF;
  SELECT count(*) INTO n FROM partner_tags WHERE tag_lookup_id = biz;
  IF n <> 4 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "business" is on % Network contacts, the dry run saw 4', n; END IF;
  SELECT count(*) INTO n FROM lead_tags WHERE tag_lookup_id = oak;
  IF n <> 1 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Oak & Key" is on % clients, the dry run saw 1', n; END IF;
  SELECT count(*) INTO n FROM partner_tags WHERE tag_lookup_id = oak;
  IF n <> 0 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Oak & Key" is on % Network contacts, the dry run saw 0', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM lead_tags WHERE tag_lookup_id = oak AND lead_id = oak_client) THEN
    RAISE EXCEPTION 'STOPPED, nothing changed: Oak & Key is no longer on the client the dry run saw';
  END IF;

  -- ── 1. groups and "shows on", into each tag's settings box ──
  UPDATE lookups l
     SET attrs = l.attrs || jsonb_build_object('group', v.grp, 'shows_on', v.shows), updated_at = now()
    FROM (VALUES
    ('0445337f-b21a-4248-b625-c1185c54b39b'::uuid, 'DO NOT BOOK', 'client_status', '["clients"]'::jsonb),
    ('0a232659-2f25-44e2-b8cc-85890998ab08'::uuid, 'Mover', 'moving_hauling', '["network"]'::jsonb),
    ('0c38bc33-aee1-47e1-b108-b80e4e9a06e2'::uuid, 'Property Management', 'home_property', '["network"]'::jsonb),
    ('126cbbe0-fbf0-4414-b999-8896ce555c49'::uuid, 'Realtor', 'home_property', '["network"]'::jsonb),
    ('1c56583a-f6f8-4249-a462-00f8acdb15f3'::uuid, 'Carpet Cleaner', 'cleaning_care', '["network"]'::jsonb),
    ('2cb76810-7094-4ad5-abc7-6dac312f2684'::uuid, 'Therapist', 'senior_living', '["network"]'::jsonb),
    ('30d4aa2c-e081-4ec0-a8a7-695a81b984bc'::uuid, 'Vendor', 'relationship', '["network"]'::jsonb),
    ('4d8cde84-00af-46b6-af89-3cdc1a36895d'::uuid, 'Piano Mover', 'moving_hauling', '["network"]'::jsonb),
    ('52d7c02a-6285-463b-86df-40ac154611b6'::uuid, 'Partner', 'relationship', '["network"]'::jsonb),
    ('565034a7-ba42-47ec-8909-0c7f7b955121'::uuid, 'Estate Sale', 'valuables_specialty', '["network"]'::jsonb),
    ('5ab93b1d-3748-4260-bc23-8fddc02468ec'::uuid, 'Paint Recycling', 'professional_services', '["network"]'::jsonb),
    ('60f04e28-391a-4476-b408-08bb8d7f1bc3'::uuid, 'Art Dealer/Mover', 'valuables_specialty', '["network"]'::jsonb),
    ('68d246ab-a051-46a6-ab00-41e99adcfe1d'::uuid, 'Cleaner', 'cleaning_care', '["network"]'::jsonb),
    ('70c06c04-d0a4-47d1-9e8a-a0b189d440f4'::uuid, 'Handyman', 'home_property', '["network"]'::jsonb),
    ('7687158c-23af-42a7-9960-329205519211'::uuid, 'Donation Pick Up', 'moving_hauling', '["network"]'::jsonb),
    ('7704a95b-e484-4b46-ac80-00c0316b851c'::uuid, 'Senior Living', 'senior_living', '["network"]'::jsonb),
    ('77c7e6dd-ef20-4c88-a109-62f42c551f7e'::uuid, 'Networking Group', 'professional_services', '["network"]'::jsonb),
    ('7a8c4a5a-c4d4-4c1d-8ca7-42c4aa282e13'::uuid, 'Consignment', 'valuables_specialty', '["network"]'::jsonb),
    ('8190d346-ee4f-4a08-bb21-bf78fd2db58d'::uuid, 'Corporate / HR', 'professional_services', '["network"]'::jsonb),
    ('87b506f4-76ff-43e5-ab04-26beff1c55e6'::uuid, 'Photographer', 'professional_services', '["network"]'::jsonb),
    ('888f2435-93aa-4dd0-b5c2-be366ef65c75'::uuid, 'Bad Number', 'client_status', '["clients"]'::jsonb),
    ('8bab53a8-2710-4a50-a656-cf49a8ff839a'::uuid, 'Closet Designer', 'design_staging', '["network"]'::jsonb),
    ('8da51056-48df-453e-ab97-e5b49da861fc'::uuid, 'Paper Shredder', 'professional_services', '["network"]'::jsonb),
    ('96ecd623-ca62-469e-bf0c-02d42db29c01'::uuid, 'Trash/Junk Haul', 'moving_hauling', '["network"]'::jsonb),
    ('97ec61e0-d3c5-4af1-bbfa-37204f909158'::uuid, 'Home Remodel', 'home_property', '["network"]'::jsonb),
    ('9acd5405-6b4d-4c48-a1e9-598637e6b229'::uuid, 'Housekeeper', 'cleaning_care', '["network"]'::jsonb),
    ('9bb11200-94a3-4075-b98d-b877864f8ca4'::uuid, 'Designer', 'design_staging', '["network"]'::jsonb),
    ('9c238880-ec5d-40db-aee7-9d05e9117720'::uuid, 'Referral', 'relationship', '["clients","network"]'::jsonb),
    ('9f975a9b-8087-4994-812f-e29cab807630'::uuid, 'Hot Lead', 'client_status', '["clients"]'::jsonb),
    ('a908626a-fbf4-4d52-b8a5-ae82035601fd'::uuid, 'Applicant', 'professional_services', '["network"]'::jsonb),
    ('ab36bf57-7410-4dfd-998d-f86b09529d21'::uuid, 'General Contractor', 'home_property', '["network"]'::jsonb),
    ('acd4baee-5524-435e-8906-c49dac1850c8'::uuid, 'Returning', 'client_status', '["clients"]'::jsonb),
    ('adee5753-1a64-450a-9434-79879a9d1046'::uuid, 'Jeweler', 'valuables_specialty', '["network"]'::jsonb),
    ('af8d79c6-634f-440c-9a07-3920ba5a3973'::uuid, 'Assistant', 'professional_services', '["network"]'::jsonb),
    ('b6728e8a-6715-4088-9ff0-a106e689f722'::uuid, 'Antique Dealer', 'valuables_specialty', '["network"]'::jsonb),
    ('c38e3ea9-1e42-4f01-bd65-ab87863c187f'::uuid, 'Friend', 'relationship', '["network"]'::jsonb),
    ('c74a2670-2eee-415a-8429-7a7fe1cfa798'::uuid, 'Follow Up', 'client_status', '["clients"]'::jsonb),
    ('d343a8f5-2bc3-4d83-b151-e84e5afe59ec'::uuid, 'Builder', 'home_property', '["network"]'::jsonb),
    ('d632d7c5-16b5-4eb0-94e6-7e5f1b06483d'::uuid, 'DO NOT BOOK', 'client_status', '["clients"]'::jsonb),
    ('d7265a6c-f0bc-4b23-8074-d520525c9332'::uuid, 'VIP', 'client_status', '["clients"]'::jsonb),
    ('d9bbdd9e-f18e-4eb2-b0d9-1f4da5bc1ca3'::uuid, 'Electrician', 'home_property', '["network"]'::jsonb),
    ('dbe7f6bb-f3a4-4e94-ac14-06b78a808a96'::uuid, 'No Show', 'client_status', '["clients"]'::jsonb),
    ('dd94385e-8cbc-4a05-8569-ad6ccc74020b'::uuid, 'Assisted Living', 'senior_living', '["network"]'::jsonb),
    ('e431be21-8c14-4f11-a0fc-babede9ab3c7'::uuid, 'Coin Collector', 'valuables_specialty', '["network"]'::jsonb),
    ('e436beca-46ba-46b8-91fd-dfb946fc3fd5'::uuid, 'Pest Control', 'home_property', '["network"]'::jsonb),
    ('e49b3ae9-e92e-4383-b964-72550acece4b'::uuid, 'Home Stager', 'design_staging', '["network"]'::jsonb),
    ('eeae9a1a-e99e-457d-b945-8219b9ceb44b'::uuid, 'Video Conversion', 'professional_services', '["network"]'::jsonb),
    ('f4a53be2-0726-40e1-a0da-168ea6147ba7'::uuid, 'Document Specialist', 'professional_services', '["network"]'::jsonb)
    ) AS v(id, label, grp, shows)
   WHERE l.id = v.id AND l.label = v.label AND l.category = 'tags';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 48 THEN RAISE EXCEPTION 'STOPPED, nothing changed: % tags matched for groups, the dry run saw 48', n; END IF;

  -- ── 2. Business Networking Group (North Jersey) → Networking Group ──
  INSERT INTO partner_tags (partner_id, tag_lookup_id, added_at, added_by)
    SELECT partner_id, ng, added_at, added_by FROM partner_tags WHERE tag_lookup_id = bng
    ON CONFLICT (partner_id, tag_lookup_id) DO NOTHING;
  INSERT INTO lead_tags (lead_id, tag_lookup_id, added_at, added_by)
    SELECT lead_id, ng, added_at, added_by FROM lead_tags WHERE tag_lookup_id = bng
    ON CONFLICT (lead_id, tag_lookup_id) DO NOTHING;
  DELETE FROM partner_tags WHERE tag_lookup_id = bng;
  DELETE FROM lead_tags WHERE tag_lookup_id = bng;
  b := delete_tag_if_unused(bng, NULL);
  IF cardinality(b) > 0 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Business Networking Group" could not be deleted: %', b; END IF;

  -- ── 3. Builder → General Contractor (Builder switched off, kept) ──
  INSERT INTO partner_tags (partner_id, tag_lookup_id, added_at, added_by)
    SELECT partner_id, gc, added_at, added_by FROM partner_tags WHERE tag_lookup_id = builder
    ON CONFLICT (partner_id, tag_lookup_id) DO NOTHING;
  INSERT INTO lead_tags (lead_id, tag_lookup_id, added_at, added_by)
    SELECT lead_id, gc, added_at, added_by FROM lead_tags WHERE tag_lookup_id = builder
    ON CONFLICT (lead_id, tag_lookup_id) DO NOTHING;
  DELETE FROM partner_tags WHERE tag_lookup_id = builder;
  DELETE FROM lead_tags WHERE tag_lookup_id = builder;
  UPDATE lookups SET is_active = false, attrs = attrs || jsonb_build_object('merged_into', gc::text), updated_at = now() WHERE id = builder;

  -- ── 4. Lead (Portland): deleted ──
  DELETE FROM lead_tags WHERE tag_lookup_id = lead_t;
  b := delete_tag_if_unused(lead_t, NULL);
  IF cardinality(b) > 0 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Lead" could not be deleted: %', b; END IF;

  -- ── 5. business (Portland): deleted ──
  DELETE FROM lead_tags WHERE tag_lookup_id = biz;
  DELETE FROM partner_tags WHERE tag_lookup_id = biz;
  b := delete_tag_if_unused(biz, NULL);
  IF cardinality(b) > 0 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "business" could not be deleted: %', b; END IF;

  -- ── 6. Oak & Key (Portland): a note on the client, then deleted ──
  INSERT INTO lead_notes (lead_id, location_uuid, kind, text, user_id, user_label)
    SELECT id, location_uuid, 'buzz', 'Oak & Key', NULL, 'Bee Hub' FROM leads WHERE id = oak_client;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'STOPPED, nothing changed: the Oak & Key client was not found for the note'; END IF;
  DELETE FROM lead_tags WHERE tag_lookup_id = oak;
  b := delete_tag_if_unused(oak, NULL);
  IF cardinality(b) > 0 THEN RAISE EXCEPTION 'STOPPED, nothing changed: "Oak & Key" could not be deleted: %', b; END IF;
END $$;

-- ── receipt: read this before saying it worked ──
-- Expect: tags_with_a_group 48, tags_left 48, gone_tags_still_there 0, deletions_recorded 4,
-- networking_group_contacts 18, general_contractor_contacts 2, builder_active false,
-- builder_links 0, oak_note 1, links_to_gone_tags 0.
SELECT
  (SELECT count(*) FROM lookups WHERE category = 'tags' AND attrs ? 'group' AND attrs ? 'shows_on') AS tags_with_a_group,
  (SELECT count(*) FROM lookups WHERE category = 'tags') AS tags_left,
  (SELECT count(*) FROM lookups WHERE id IN ('a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid)) AS gone_tags_still_there,
  (SELECT count(*) FROM tag_deletions WHERE tag_id IN ('a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid)) AS deletions_recorded,
  (SELECT count(*) FROM partner_tags WHERE tag_lookup_id = '77c7e6dd-ef20-4c88-a109-62f42c551f7e') AS networking_group_contacts,
  (SELECT count(*) FROM partner_tags WHERE tag_lookup_id = 'ab36bf57-7410-4dfd-998d-f86b09529d21') AS general_contractor_contacts,
  (SELECT is_active FROM lookups WHERE id = 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec') AS builder_active,
  (SELECT count(*) FROM partner_tags WHERE tag_lookup_id = 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec') + (SELECT count(*) FROM lead_tags WHERE tag_lookup_id = 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec') AS builder_links,
  (SELECT count(*) FROM lead_notes WHERE lead_id = '1aee24bc-5e99-4a94-87b2-f5515fdab2f7' AND text = 'Oak & Key' AND user_label = 'Bee Hub') AS oak_note,
  (SELECT count(*) FROM lead_tags WHERE tag_lookup_id IN ('a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid)) + (SELECT count(*) FROM partner_tags WHERE tag_lookup_id IN ('a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid)) AS links_to_gone_tags;
