-- migrations/button_align.sql
--
-- WHERE THE BUTTON SITS (2026-10-30, the Lovable button section). Left,
-- centre or right. NULL is centre, which is where every button sat before
-- this column existed — so no email changes when this runs.
--
-- The screen and the senders work before this runs: alignment is simply not
-- offered, and every button renders centred (lib/drip-step-extras.ts,
-- lib/email-send-options.ts, lib/drip-email-layout.ts buttonAlignOf).
--
-- Adds empty columns only. Single statement each, safe to re-run.
alter table public.drip_path_steps
  add column if not exists button_align text
  check (button_align is null or button_align in ('left','center','right'));
alter table public.templates
  add column if not exists button_align text
  check (button_align is null or button_align in ('left','center','right'));
