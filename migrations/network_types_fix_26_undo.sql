-- UNDO for migrations/network_types_fix_26.sql: the same 26 back to empty.
-- (Run only if the fix was wrong: it also blanks any type an owner set on
-- one of these 26 after the fix ran.)
update public.partners
set network_types = null, partner_level = null, partner_stage = null
where id in ('b7debef2-d4fa-49a9-99ff-6f259bc4a216',
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
