-- migrations/drip_path_steps_paused.sql
--
-- PAUSE ONE EMAIL (Settings → Emails → Pause). Different from Remove
-- (is_active = false): a paused email stays in its place in the list, says
-- "Paused", and is not sent. At send time it is passed over exactly like a
-- removed one — the client moves on to the next email on its own date
-- (lib/drip-followups.ts dripStepDecision → 'skip_paused'). Start puts it back.
--
-- Step 1 can never be paused (the first email always sends) — refused in
-- app/api/drip-paths/[id]/steps and ignored by the sender.
--
-- Default false = every email sends as today. The app reads this column
-- tolerantly; until this runs the Pause button refuses to save.
--
-- Single statement, safe to re-run.
alter table public.drip_path_steps
  add column if not exists is_paused boolean not null default false;
