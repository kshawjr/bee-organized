-- migrations/reminders_from_next_steps.sql
--
-- Carry Network "What's next" items (partners.next_steps) over into Reminders.
--
-- WRITTEN, NOT RUN. Run AFTER migrations/reminders.sql, and BEFORE the code
-- that retires the "What's next" section is pushed — otherwise the existing
-- items stop showing anywhere until this runs. (Nothing is lost either way:
-- this script never edits or deletes partners.next_steps.)
--
-- TWO STEPS. Run STEP 1 on its own, read it, and only then run STEP 2.
--
-- THE CATCH, and why step 1 exists: a next step never recorded WHO wrote it.
-- The only person on file is partners.created_by — whoever added the Network
-- person, which for imported people may be Kevin, not the owner. Step 2 gives
-- each reminder to that person. If step 1 shows the wrong owner, stop and
-- decide by hand; do not run step 2.
--
-- What converts: open (not done), dated steps on Network people that still
-- exist and have a created_by. Everything else is listed by step 1 with the
-- reason it will be skipped (a reminder needs a date and an owner).

-- ═══ STEP 1 — PREVIEW (read-only) ═══════════════════════════════════════
SELECT
  p.id                              AS partner_id,
  p.name                            AS network_person,
  l.name                            AS location,
  s->>'text'                        AS note,
  s->>'date'                        AS due_on,
  COALESCE((s->>'done')::boolean, false) AS done,
  p.created_by                      AS would_belong_to,
  hu.full_name                      AS would_belong_to_name,
  CASE
    WHEN p.deleted_at IS NOT NULL                          THEN 'skip: person removed from Network'
    WHEN COALESCE((s->>'done')::boolean, false)            THEN 'skip: already done'
    WHEN NULLIF(s->>'date', '') IS NULL                    THEN 'skip: no date'
    WHEN NULLIF(btrim(s->>'text'), '') IS NULL             THEN 'skip: no note'
    WHEN p.created_by IS NULL                              THEN 'skip: nobody on file to own it'
    ELSE 'CONVERT'
  END                               AS outcome
FROM public.partners p
CROSS JOIN LATERAL jsonb_array_elements(p.next_steps) s
LEFT JOIN public.locations l ON l.id = p.location_id
LEFT JOIN public.hub_users hu ON hu.id = p.created_by
WHERE jsonb_typeof(p.next_steps) = 'array'
ORDER BY outcome, p.name;

-- ═══ STEP 2 — CONVERT (writes; run only after reading step 1) ═══════════
-- One statement, no temp tables (the Supabase editor drops them between
-- statements). Safe to re-run: a step already carried over is not copied
-- twice.
WITH steps AS (
  SELECT
    p.id           AS partner_id,
    p.location_id  AS location_uuid,
    p.created_by   AS user_id,
    btrim(s->>'text')    AS note,
    (s->>'date')::date   AS due_on
  FROM public.partners p
  CROSS JOIN LATERAL jsonb_array_elements(p.next_steps) s
  WHERE jsonb_typeof(p.next_steps) = 'array'
    AND p.deleted_at IS NULL
    AND p.created_by IS NOT NULL
    AND NOT COALESCE((s->>'done')::boolean, false)
    AND NULLIF(s->>'date', '') IS NOT NULL
    AND NULLIF(btrim(s->>'text'), '') IS NOT NULL
)
INSERT INTO public.reminders (user_id, location_uuid, partner_id, due_on, note)
SELECT st.user_id, st.location_uuid, st.partner_id, st.due_on, left(st.note, 500)
FROM steps st
WHERE NOT EXISTS (
  SELECT 1 FROM public.reminders r
  WHERE r.partner_id = st.partner_id AND r.due_on = st.due_on AND r.note = left(st.note, 500)
)
RETURNING id, partner_id, user_id, due_on, note;
