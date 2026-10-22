-- migrations/feedback_items_clickup_task_id_undo.sql
--
-- Undo for migrations/feedback_items_clickup_task_id.sql.
--
-- HELD: run this by hand (Kevin).
--
-- WHAT IT LOSES: every stored clickup_task_id. Once dropped, Bee Hub no longer
-- knows which ClickUp task belongs to which item; the tasks themselves stay in
-- ClickUp and still carry the Bee Desk ID custom field, so the link can be
-- rebuilt from ClickUp if needed. Deploy the code revert first, or triage will
-- log a sync_log error on every save that would have created a task.
--
-- THE sync_log HALF FAILS LOUDLY IF FEEDBACK ROWS EXIST. Re-adding the old
-- CHECK validates every row, and any sync_log row with entity_type='feedback'
-- violates it, so the whole transaction rolls back and nothing is undone. That
-- is deliberate: those rows are the record of which owners were or were not
-- replied to, and an undo must not delete them on its own. Check first:
--
--   SELECT count(*) FROM sync_log WHERE entity_type = 'feedback';
--
-- If it is not 0 and you still want the old CHECK back, decide what happens to
-- those rows first; this file will not decide it for you.

BEGIN;

DROP INDEX IF EXISTS public.feedback_items_clickup_task_id_key;

ALTER TABLE public.feedback_items
  DROP COLUMN IF EXISTS clickup_task_id;

ALTER TABLE public.sync_log
  DROP CONSTRAINT IF EXISTS sync_log_entity_type_check;

ALTER TABLE public.sync_log
  ADD CONSTRAINT sync_log_entity_type_check
  CHECK (entity_type IN (
    'client', 'request', 'quote', 'job', 'invoice',
    'payment', 'note', 'location', 'property', 'assessment',
    'engagement'
  ));

COMMIT;
