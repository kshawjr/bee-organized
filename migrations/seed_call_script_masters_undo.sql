-- ═════════════════════════════════════════════════════════════════════════════
-- UNDO: SEED THE FIVE BEE ORGANIZED CALL SCRIPTS
-- ═════════════════════════════════════════════════════════════════════════════
--
-- KEVIN RUNS THIS, and only if the five scripts should go.
--
-- Removes the five rows migrations/seed_call_script_masters.sql added, and
-- only those: it names them by legacy_id and will not touch a row that has a
-- location. Nothing else in `templates` is changed.
--
-- WHAT HAPPENS TO COPIES. An owner who used "Make my own copy" has their own
-- row, in their own location. This does NOT delete it: the copy stays theirs,
-- and only its note of which script it was copied from is cleared (the
-- table's own rule: cloned_from_id ... ON DELETE SET NULL).
--
-- LOOK FIRST — reads only. The rows that would be removed, and how many
-- copies owners have made of each:
--
--   select t.legacy_id, t.name, t.updated_at,
--          (select count(*) from public.templates c where c.cloned_from_id = t.id) as copies
--   from public.templates t
--   where t.location_uuid is null
--     and t.legacy_id in ('call_new_lead_callback', 'call_past_client_check_in', 'call_realtor_partnership_intro', 'call_quote_follow_up', 'call_senior_move_downsizing');
--
-- One statement. It returns the rows it removed.

delete from public.templates
where location_uuid is null
  and type = 'call'
  and legacy_id in ('call_new_lead_callback', 'call_past_client_check_in', 'call_realtor_partnership_intro', 'call_quote_follow_up', 'call_senior_move_downsizing')
returning legacy_id, name;
