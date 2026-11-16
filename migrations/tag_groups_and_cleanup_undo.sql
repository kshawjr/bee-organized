-- migrations/tag_groups_and_cleanup_undo.sql
--
-- Puts back everything migrations/tag_groups_and_cleanup.sql changed, from the
-- values production held at the dry run (2026-11-15):
--   · the four deleted tags come back with their own ids and settings
--   · every tag link that was removed comes back, with its original date
--   · the merged-in links (to Networking Group and General Contractor) go
--   · Builder is switched back on
--   · every tag's settings box is put back exactly as it was
--   · the "Oak & Key" note this change wrote is removed
-- One block: all of it or none of it. DATA only, no schema change.

DO $$
DECLARE n int;
BEGIN
  -- the deleted tags, whole
  INSERT INTO lookups (id, category, label, sort_order, color, bg_color, icon, description, attrs, is_active, created_at, updated_at, location_id)
    SELECT r.id, r.category, r.label, r.sort_order, r.color, r.bg_color, r.icon, r.description, r.attrs, r.is_active, r.created_at, r.updated_at, r.location_id
      FROM jsonb_populate_recordset(NULL::lookups, '[{"id":"a433ba77-dae7-46ae-96c2-296246d331cf","category":"tags","label":"Business Networking Group","sort_order":4010,"color":null,"bg_color":null,"icon":null,"description":null,"attrs":{"section":"trade","created_by_user":"ef309bb9-7289-49d8-ae55-c0a07c38a0fd"},"is_active":true,"created_at":"2026-10-24T00:51:55.901504+00:00","updated_at":"2026-10-24T00:51:55.901504+00:00","location_id":"0e141f31-eb97-4f91-8cde-e56cab804653"},{"id":"c02da184-5e25-4690-9e8e-27fd525ff2f5","category":"tags","label":"Lead","sort_order":1090,"color":null,"bg_color":null,"icon":null,"description":null,"attrs":{"section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":90},"is_active":true,"created_at":"2026-09-24T00:57:54.996841+00:00","updated_at":"2026-10-22T16:49:54.585+00:00","location_id":"80ffb75d-44a9-4160-aee1-9919dd97de97"},{"id":"b63db20f-ef18-4cc6-93e5-d6682ba10c73","category":"tags","label":"business","sort_order":4000,"color":null,"bg_color":null,"icon":"🗄️","description":null,"attrs":{"section":"trade","created_by_user":"ed2be316-67f1-44e9-bac9-7ee97832aded"},"is_active":true,"created_at":"2026-10-21T18:58:49.744585+00:00","updated_at":"2026-10-21T18:58:49.744585+00:00","location_id":"80ffb75d-44a9-4160-aee1-9919dd97de97"},{"id":"97b8901d-283b-4e8e-a316-f268f1e96bfe","category":"tags","label":"Oak & Key","sort_order":4030,"color":null,"bg_color":null,"icon":null,"description":null,"attrs":{"section":"trade","created_by_user":"ed2be316-67f1-44e9-bac9-7ee97832aded"},"is_active":true,"created_at":"2026-11-11T22:23:46.721956+00:00","updated_at":"2026-11-11T22:23:46.721956+00:00","location_id":"80ffb75d-44a9-4160-aee1-9919dd97de97"}]'::jsonb) r
    ON CONFLICT (id) DO NOTHING;
  DELETE FROM tag_deletions WHERE tag_id IN ('a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid);

  -- the merged-in links go (none of these people carried the target before)
  DELETE FROM partner_tags WHERE tag_lookup_id = '77c7e6dd-ef20-4c88-a109-62f42c551f7e' AND partner_id IN ('4822b69e-72c7-4959-84c0-a3d7206199b7'::uuid, '69f5dee3-7ec1-41fe-8b01-fa7ab80412c5'::uuid, 'd5d2e6e6-d619-49cd-bab5-9f43a2d9f2c7'::uuid);
  DELETE FROM partner_tags WHERE tag_lookup_id = 'ab36bf57-7410-4dfd-998d-f86b09529d21' AND partner_id IN ('e38abd40-001a-4970-b040-955b864a04f1'::uuid);

  -- every removed link comes back
  INSERT INTO lead_tags (lead_id, tag_lookup_id, added_at, added_by) VALUES
    ('7b7e66b2-fa8b-4567-b4d8-379ca5892440'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, '2026-09-24T00:58:00.290778+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('e2f50265-6ded-4e1c-9ce3-19a4c1439787'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, '2026-10-22T16:50:02.248976+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('9903e4ff-f973-4bc5-8ead-4f1c6fd01d91'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '2026-10-21T19:22:59.255613+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('9e226483-5f0a-4289-b4e2-75b8833cb3f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '2026-10-21T19:24:13.732322+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('afa25cbe-d406-4533-84c8-1afb8abbd977'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '2026-10-21T19:03:32.362546+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('1aee24bc-5e99-4a94-87b2-f5515fdab2f7'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid, '2026-11-11T22:23:49.798961+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid)
    ON CONFLICT (lead_id, tag_lookup_id) DO NOTHING;
  INSERT INTO partner_tags (partner_id, tag_lookup_id, added_at, added_by) VALUES
    ('077dc415-e0fc-4dd1-82ab-8decb9e64ce6'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '2026-10-21T18:59:05.130554+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('210f2577-49ac-449c-bd07-8bc36ddecffb'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '2026-10-21T19:03:27.343868+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('2598f9e4-5aac-4d2a-afe0-01e85e521262'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '2026-10-21T19:22:52.109369+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('b8c284dd-2d40-4f84-8669-1fbe3f2c7dad'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '2026-10-21T19:23:59.995373+00:00'::timestamptz, 'ed2be316-67f1-44e9-bac9-7ee97832aded'::uuid),
    ('4822b69e-72c7-4959-84c0-a3d7206199b7'::uuid, 'a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, '2026-10-24T01:00:15.7947+00:00'::timestamptz, 'ef309bb9-7289-49d8-ae55-c0a07c38a0fd'::uuid),
    ('69f5dee3-7ec1-41fe-8b01-fa7ab80412c5'::uuid, 'a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, '2026-10-24T00:52:04.653192+00:00'::timestamptz, 'ef309bb9-7289-49d8-ae55-c0a07c38a0fd'::uuid),
    ('d5d2e6e6-d619-49cd-bab5-9f43a2d9f2c7'::uuid, 'a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, '2026-10-24T00:58:54.06448+00:00'::timestamptz, 'ef309bb9-7289-49d8-ae55-c0a07c38a0fd'::uuid),
    ('e38abd40-001a-4970-b040-955b864a04f1'::uuid, 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec'::uuid, '2026-11-16T03:57:06.403425+00:00'::timestamptz, '63785d40-38fe-4390-ad9e-6072ddfb6df9'::uuid)
    ON CONFLICT (partner_id, tag_lookup_id) DO NOTHING;

  -- every tag's settings box, switch and last-changed time, exactly as they were
  UPDATE lookups l SET attrs = v.attrs, is_active = v.is_active, updated_at = v.updated_at
    FROM (VALUES
    ('0445337f-b21a-4248-b625-c1185c54b39b'::uuid, '{"section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":80}'::jsonb, false, '2026-10-16T08:47:53.715047+00:00'::timestamptz),
    ('0a232659-2f25-44e2-b8cc-85890998ab08'::uuid, '{"key":"moving-company","group":"moving_hauling","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":150}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('0c38bc33-aee1-47e1-b108-b80e4e9a06e2'::uuid, '{"key":"property-manager","group":"home_property","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":70}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('126cbbe0-fbf0-4414-b999-8896ce555c49'::uuid, '{"key":"real-estate","group":"home_property","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":10}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('1c56583a-f6f8-4249-a462-00f8acdb15f3'::uuid, '{"key":"carpet-cleaner","group":"cleaning_care","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":140}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('2cb76810-7094-4ad5-abc7-6dac312f2684'::uuid, '{"key":"therapist","group":"senior_living","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":210}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('30d4aa2c-e081-4ec0-a8a7-695a81b984bc'::uuid, '{"key":"vendor","section":"relationship","created_by":"relationship_to_tags","section_set_by":"tag_sections"}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('4d8cde84-00af-46b6-af89-3cdc1a36895d'::uuid, '{"key":"piano-mover","group":"moving_hauling","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":160}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('52d7c02a-6285-463b-86df-40ac154611b6'::uuid, '{"section":"relationship","merged_from":"partner_tags","section_set_by":"tag_sections","merged_sort_order":10}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('565034a7-ba42-47ec-8909-0c7f7b955121'::uuid, '{"key":"estate-sale","group":"valuables_specialty","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":220}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('5ab93b1d-3748-4260-bc23-8fddc02468ec'::uuid, '{"key":"paint-recycling","group":"professional_services","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":320}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('60f04e28-391a-4476-b408-08bb8d7f1bc3'::uuid, '{"key":"art-dealer","group":"valuables_specialty","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":240}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('68d246ab-a051-46a6-ab00-41e99adcfe1d'::uuid, '{"key":"cleaning","group":"cleaning_care","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":120}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('70c06c04-d0a4-47d1-9e8a-a0b189d440f4'::uuid, '{"key":"handyman","group":"home_property","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":60}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('7687158c-23af-42a7-9960-329205519211'::uuid, '{"key":"donation-pickup","group":"moving_hauling","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":180}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('7704a95b-e484-4b46-ac80-00c0316b851c'::uuid, '{"key":"senior-living","group":"senior_living","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":190}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('77c7e6dd-ef20-4c88-a109-62f42c551f7e'::uuid, '{"key":"networking","group":"professional_services","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":350}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('7a8c4a5a-c4d4-4c1d-8ca7-42c4aa282e13'::uuid, '{"key":"consignment","group":"valuables_specialty","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":250}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('8190d346-ee4f-4a08-bb21-bf78fd2db58d'::uuid, '{"key":"corporate","group":"professional_services","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":330}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('87b506f4-76ff-43e5-ab04-26beff1c55e6'::uuid, '{"key":"photographer","group":"professional_services","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":280}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('888f2435-93aa-4dd0-b5c2-be366ef65c75'::uuid, '{"key":"badnumber","section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":50}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('8bab53a8-2710-4a50-a656-cf49a8ff839a'::uuid, '{"key":"closet-designer","group":"design_staging","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":100}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('8da51056-48df-453e-ab97-e5b49da861fc'::uuid, '{"key":"paper-shredder","group":"professional_services","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":300}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('96ecd623-ca62-469e-bf0c-02d42db29c01'::uuid, '{"key":"junk-haul","group":"moving_hauling","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":170}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('97ec61e0-d3c5-4af1-bbfa-37204f909158'::uuid, '{"key":"home-remodel","group":"home_property","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":30}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('9acd5405-6b4d-4c48-a1e9-598637e6b229'::uuid, '{"key":"housekeeper","group":"cleaning_care","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":130}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('9bb11200-94a3-4075-b98d-b877864f8ca4'::uuid, '{"key":"interior-designer","group":"design_staging","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":90}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('9c238880-ec5d-40db-aee7-9d05e9117720'::uuid, '{"key":"referral","section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":30}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('9f975a9b-8087-4994-812f-e29cab807630'::uuid, '{"key":"hot","section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":10}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('a908626a-fbf4-4d52-b8a5-ae82035601fd'::uuid, '{"section":"trade","created_by_user":"fa2dd092-3453-4ac1-90d0-73095e9738bb"}'::jsonb, true, '2026-11-09T22:00:20.161249+00:00'::timestamptz),
    ('ab36bf57-7410-4dfd-998d-f86b09529d21'::uuid, '{"key":"contractor","group":"home_property","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":20}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('acd4baee-5524-435e-8906-c49dac1850c8'::uuid, '{"key":"returning","section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":40}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('adee5753-1a64-450a-9434-79879a9d1046'::uuid, '{"key":"jeweler","group":"valuables_specialty","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":270}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('af8d79c6-634f-440c-9a07-3920ba5a3973'::uuid, '{"key":"assistant","group":"professional_services","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":340}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('b6728e8a-6715-4088-9ff0-a106e689f722'::uuid, '{"key":"antique","group":"valuables_specialty","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":230}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('c38e3ea9-1e42-4f01-bd65-ab87863c187f'::uuid, '{"key":"friend","section":"relationship","created_by":"relationship_to_tags","section_set_by":"tag_sections"}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('c74a2670-2eee-415a-8429-7a7fe1cfa798'::uuid, '{"key":"followup","section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":70}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('d343a8f5-2bc3-4d83-b151-e84e5afe59ec'::uuid, '{"key":"builder","group":"home_property","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":40}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('d632d7c5-16b5-4eb0-94e6-7e5f1b06483d'::uuid, '{"section":"relationship","promoted_from":["0445337f-b21a-4248-b625-c1185c54b39b"]}'::jsonb, true, '2026-10-16T08:47:53.715047+00:00'::timestamptz),
    ('d7265a6c-f0bc-4b23-8074-d520525c9332'::uuid, '{"key":"vip","section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":20}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('d9bbdd9e-f18e-4eb2-b0d9-1f4da5bc1ca3'::uuid, '{"key":"electrician","group":"home_property","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":50}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('dbe7f6bb-f3a4-4e94-ac14-06b78a808a96'::uuid, '{"key":"noshow","section":"relationship","merged_from":"client_tags","section_set_by":"tag_sections","merged_sort_order":60}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('dd94385e-8cbc-4a05-8569-ad6ccc74020b'::uuid, '{"key":"assisted-living","group":"senior_living","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":200}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('e431be21-8c14-4f11-a0fc-babede9ab3c7'::uuid, '{"key":"coin-collector","group":"valuables_specialty","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":260}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('e436beca-46ba-46b8-91fd-dfb946fc3fd5'::uuid, '{"key":"pest-control","group":"home_property","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":80}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('e49b3ae9-e92e-4383-b964-72550acece4b'::uuid, '{"key":"stager","group":"design_staging","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":110}'::jsonb, true, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('eeae9a1a-e99e-457d-b945-8219b9ceb44b'::uuid, '{"key":"video-conversion","group":"professional_services","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":310}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz),
    ('f4a53be2-0726-40e1-a0da-168ea6147ba7'::uuid, '{"key":"document-specialist","group":"professional_services","section":"trade","merged_from":"partner_specialties","section_set_by":"tag_sections","merged_sort_order":290}'::jsonb, false, '2026-10-16T03:34:34.569131+00:00'::timestamptz)
    ) AS v(id, attrs, is_active, updated_at)
   WHERE l.id = v.id;

  -- the note this change wrote
  DELETE FROM lead_notes WHERE lead_id = '1aee24bc-5e99-4a94-87b2-f5515fdab2f7' AND text = 'Oak & Key' AND user_label = 'Bee Hub' AND user_id IS NULL AND kind = 'buzz';
END $$;

-- receipt. Expect: gone_tags_back 4, builder_active true, links_back 14, tags_with_shows_on 0, oak_note 0.
SELECT
  (SELECT count(*) FROM lookups WHERE id IN ('a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid)) AS gone_tags_back,
  (SELECT is_active FROM lookups WHERE id = 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec') AS builder_active,
  (SELECT count(*) FROM lead_tags WHERE tag_lookup_id IN ('c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid, 'a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec'::uuid)) + (SELECT count(*) FROM partner_tags WHERE tag_lookup_id IN ('b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, 'a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec'::uuid)) AS links_back,
  (SELECT count(*) FROM lookups WHERE category = 'tags' AND attrs ? 'shows_on') AS tags_with_shows_on,
  (SELECT count(*) FROM lead_notes WHERE lead_id = '1aee24bc-5e99-4a94-87b2-f5515fdab2f7' AND text = 'Oak & Key' AND user_label = 'Bee Hub') AS oak_note;
