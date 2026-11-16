-- migrations/tag_groups_and_cleanup_check.sql
--
-- READ-ONLY. Run this BEFORE tag_groups_and_cleanup.sql. It changes nothing.
-- It lists, as production stands at the moment you run it, every record the
-- change will touch. Compare it with the dry-run list; if they differ, do not
-- run the change (it would stop by itself anyway).

SELECT 'A. client loses a tag' AS what, t.label AS tag, coalesce(loc.name, 'corporate') AS tag_owner, ld.name AS who, ll.name AS their_location, lt.lead_id AS record_id
  FROM lead_tags lt JOIN lookups t ON t.id = lt.tag_lookup_id LEFT JOIN locations loc ON loc.id = t.location_id
  JOIN leads ld ON ld.id = lt.lead_id LEFT JOIN locations ll ON ll.id = ld.location_uuid
 WHERE t.id IN ('c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid)
UNION ALL
SELECT 'B. Network contact loses a tag', t.label, coalesce(loc.name, 'corporate'), p.name, pl.name, pt.partner_id
  FROM partner_tags pt JOIN lookups t ON t.id = pt.tag_lookup_id LEFT JOIN locations loc ON loc.id = t.location_id
  JOIN partners p ON p.id = pt.partner_id LEFT JOIN locations pl ON pl.id = p.location_id
 WHERE t.id IN ('b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid)
UNION ALL
SELECT 'C. Network contact moves to the merged tag', t.label || ' -> ' || CASE WHEN t.id = 'a433ba77-dae7-46ae-96c2-296246d331cf' THEN 'Networking Group' ELSE 'General Contractor' END, coalesce(loc.name, 'corporate'), p.name, pl.name, pt.partner_id
  FROM partner_tags pt JOIN lookups t ON t.id = pt.tag_lookup_id LEFT JOIN locations loc ON loc.id = t.location_id
  JOIN partners p ON p.id = pt.partner_id LEFT JOIN locations pl ON pl.id = p.location_id
 WHERE t.id IN ('a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec'::uuid)
UNION ALL
SELECT 'D. client gets the note "Oak & Key"', 'Oak & Key', 'Portland', ld.name, ll.name, ld.id
  FROM leads ld LEFT JOIN locations ll ON ll.id = ld.location_uuid WHERE ld.id = '1aee24bc-5e99-4a94-87b2-f5515fdab2f7'
UNION ALL
SELECT 'E. tag deleted', t.label, coalesce(loc.name, 'corporate'), NULL, NULL, t.id
  FROM lookups t LEFT JOIN locations loc ON loc.id = t.location_id WHERE t.id IN ('a433ba77-dae7-46ae-96c2-296246d331cf'::uuid, 'c02da184-5e25-4690-9e8e-27fd525ff2f5'::uuid, 'b63db20f-ef18-4cc6-93e5-d6682ba10c73'::uuid, '97b8901d-283b-4e8e-a316-f268f1e96bfe'::uuid)
UNION ALL
SELECT 'F. tag switched off (merged)', t.label, 'corporate', NULL, NULL, t.id FROM lookups t WHERE t.id = 'd343a8f5-2bc3-4d83-b151-e84e5afe59ec'
UNION ALL
SELECT 'G. tag gets a group: ' || v.grp || ' / shows on ' || v.shows, t.label, coalesce(loc.name, 'corporate'), CASE WHEN t.is_active THEN NULL ELSE '(switched off)' END, NULL, t.id
  FROM (VALUES
    ('0445337f-b21a-4248-b625-c1185c54b39b'::uuid, 'client_status', 'clients'),
    ('0a232659-2f25-44e2-b8cc-85890998ab08'::uuid, 'moving_hauling', 'network'),
    ('0c38bc33-aee1-47e1-b108-b80e4e9a06e2'::uuid, 'home_property', 'network'),
    ('126cbbe0-fbf0-4414-b999-8896ce555c49'::uuid, 'home_property', 'network'),
    ('1c56583a-f6f8-4249-a462-00f8acdb15f3'::uuid, 'cleaning_care', 'network'),
    ('2cb76810-7094-4ad5-abc7-6dac312f2684'::uuid, 'senior_living', 'network'),
    ('30d4aa2c-e081-4ec0-a8a7-695a81b984bc'::uuid, 'relationship', 'network'),
    ('4d8cde84-00af-46b6-af89-3cdc1a36895d'::uuid, 'moving_hauling', 'network'),
    ('52d7c02a-6285-463b-86df-40ac154611b6'::uuid, 'relationship', 'network'),
    ('565034a7-ba42-47ec-8909-0c7f7b955121'::uuid, 'valuables_specialty', 'network'),
    ('5ab93b1d-3748-4260-bc23-8fddc02468ec'::uuid, 'professional_services', 'network'),
    ('60f04e28-391a-4476-b408-08bb8d7f1bc3'::uuid, 'valuables_specialty', 'network'),
    ('68d246ab-a051-46a6-ab00-41e99adcfe1d'::uuid, 'cleaning_care', 'network'),
    ('70c06c04-d0a4-47d1-9e8a-a0b189d440f4'::uuid, 'home_property', 'network'),
    ('7687158c-23af-42a7-9960-329205519211'::uuid, 'moving_hauling', 'network'),
    ('7704a95b-e484-4b46-ac80-00c0316b851c'::uuid, 'senior_living', 'network'),
    ('77c7e6dd-ef20-4c88-a109-62f42c551f7e'::uuid, 'professional_services', 'network'),
    ('7a8c4a5a-c4d4-4c1d-8ca7-42c4aa282e13'::uuid, 'valuables_specialty', 'network'),
    ('8190d346-ee4f-4a08-bb21-bf78fd2db58d'::uuid, 'professional_services', 'network'),
    ('87b506f4-76ff-43e5-ab04-26beff1c55e6'::uuid, 'professional_services', 'network'),
    ('888f2435-93aa-4dd0-b5c2-be366ef65c75'::uuid, 'client_status', 'clients'),
    ('8bab53a8-2710-4a50-a656-cf49a8ff839a'::uuid, 'design_staging', 'network'),
    ('8da51056-48df-453e-ab97-e5b49da861fc'::uuid, 'professional_services', 'network'),
    ('96ecd623-ca62-469e-bf0c-02d42db29c01'::uuid, 'moving_hauling', 'network'),
    ('97ec61e0-d3c5-4af1-bbfa-37204f909158'::uuid, 'home_property', 'network'),
    ('9acd5405-6b4d-4c48-a1e9-598637e6b229'::uuid, 'cleaning_care', 'network'),
    ('9bb11200-94a3-4075-b98d-b877864f8ca4'::uuid, 'design_staging', 'network'),
    ('9c238880-ec5d-40db-aee7-9d05e9117720'::uuid, 'relationship', 'clients + network'),
    ('9f975a9b-8087-4994-812f-e29cab807630'::uuid, 'client_status', 'clients'),
    ('a908626a-fbf4-4d52-b8a5-ae82035601fd'::uuid, 'professional_services', 'network'),
    ('ab36bf57-7410-4dfd-998d-f86b09529d21'::uuid, 'home_property', 'network'),
    ('acd4baee-5524-435e-8906-c49dac1850c8'::uuid, 'client_status', 'clients'),
    ('adee5753-1a64-450a-9434-79879a9d1046'::uuid, 'valuables_specialty', 'network'),
    ('af8d79c6-634f-440c-9a07-3920ba5a3973'::uuid, 'professional_services', 'network'),
    ('b6728e8a-6715-4088-9ff0-a106e689f722'::uuid, 'valuables_specialty', 'network'),
    ('c38e3ea9-1e42-4f01-bd65-ab87863c187f'::uuid, 'relationship', 'network'),
    ('c74a2670-2eee-415a-8429-7a7fe1cfa798'::uuid, 'client_status', 'clients'),
    ('d343a8f5-2bc3-4d83-b151-e84e5afe59ec'::uuid, 'home_property', 'network'),
    ('d632d7c5-16b5-4eb0-94e6-7e5f1b06483d'::uuid, 'client_status', 'clients'),
    ('d7265a6c-f0bc-4b23-8074-d520525c9332'::uuid, 'client_status', 'clients'),
    ('d9bbdd9e-f18e-4eb2-b0d9-1f4da5bc1ca3'::uuid, 'home_property', 'network'),
    ('dbe7f6bb-f3a4-4e94-ac14-06b78a808a96'::uuid, 'client_status', 'clients'),
    ('dd94385e-8cbc-4a05-8569-ad6ccc74020b'::uuid, 'senior_living', 'network'),
    ('e431be21-8c14-4f11-a0fc-babede9ab3c7'::uuid, 'valuables_specialty', 'network'),
    ('e436beca-46ba-46b8-91fd-dfb946fc3fd5'::uuid, 'home_property', 'network'),
    ('e49b3ae9-e92e-4383-b964-72550acece4b'::uuid, 'design_staging', 'network'),
    ('eeae9a1a-e99e-457d-b945-8219b9ceb44b'::uuid, 'professional_services', 'network'),
    ('f4a53be2-0726-40e1-a0da-168ea6147ba7'::uuid, 'professional_services', 'network')
  ) AS v(id, grp, shows) JOIN lookups t ON t.id = v.id LEFT JOIN locations loc ON loc.id = t.location_id
ORDER BY 1, 2, 4;
