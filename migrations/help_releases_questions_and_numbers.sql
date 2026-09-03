-- ════════════════════════════════════════════════════════════════════
--  What's new — the questions group and the number nobody sees.
--  Apply via the Supabase SQL editor, AFTER help_releases.sql. Kevin
--  runs it; the code never does. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════
--
-- What this does, in order:
--   1. Lets a line be a QUESTION. help_release_items."group" gains a
--      fourth value, 'question': the line's title is what was asked and
--      its body is what we said. A feedback entry marked Answered seeds
--      one of these into the open draft — title + latest reply, no name,
--      no email, no user id — with edited_at NULL, so it stays out of Help
--      and out of the Slack post until Kevin rewrites both halves.
--   2. Gives each PUBLISHED release a sequential number, assigned by the
--      publish route (max + 1), unique, never shown to owners and never in
--      the post. It exists so Kevin can say "that went out in 12".
--      Existing published rows are numbered here in publish order.
--
-- feedback_items, feedback_replies and help_entries are NOT touched.
--
-- Deploy order: the code is safe BEFORE or AFTER this runs. Before it:
--   · marking an entry Answered tries to seed a 'question' line, the CHECK
--     refuses it, the seed logs a warning and the save + email proceed;
--   · publishing still publishes — the number is a separate best-effort
--     write that fails quietly until the column exists.

-- ─── 1. the questions group ──────────────────────────────────────────

alter table public.help_release_items
  drop constraint if exists help_release_items_group_check;

alter table public.help_release_items
  add constraint help_release_items_group_check
  check ("group" in ('new','changed','fixed','question'));

-- ─── 2. the number ───────────────────────────────────────────────────

alter table public.help_releases
  add column if not exists number integer;

create unique index if not exists help_releases_number_idx
  on public.help_releases (number) where number is not null;

-- Number anything already published, oldest first, without renumbering
-- anything that already has one.
with ordered as (
  select id, row_number() over (order by published_at, created_at) as n
  from public.help_releases
  where status = 'published' and number is null
), base as (
  select coalesce(max(number), 0) as max_n from public.help_releases
)
update public.help_releases r
set number = ordered.n + base.max_n
from ordered, base
where r.id = ordered.id;

comment on column public.help_releases.number is
  'Sequential over published releases, assigned at publish. Editors only: owners never see it and the Slack post never carries it.';
