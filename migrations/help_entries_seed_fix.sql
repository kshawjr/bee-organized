-- ════════════════════════════════════════════════════════════════════
--  Help sections — fix the seed to match the real nav.
--  HELD. Kevin runs it in the Supabase SQL editor. Nothing here is DDL.
-- ════════════════════════════════════════════════════════════════════
--
-- The first seed (migrations/help_entries.sql) put in: Getting started,
-- Home, Inbox, Clients, Reports, Settings. The nav is actually:
-- Home, Clients, Network, Reports, Back Office, Settings, Help, Admin.
--
-- So:
--   · Inbox is a view inside Clients, not a tab → soft-deleted, and ONLY if
--     nothing live sits under it (checked at 2026-09-03: 0 topics, 0 items).
--     If someone has since filed content under it, the guard below leaves
--     it alone and the SELECT at the end shows you what is there.
--   · Network, Back Office and Admin are added (Help itself gets no section
--     — help about Help is a page nobody asked for).
--   · Positions are renumbered to the nav order, Getting started first.
--   · Settings (1 topic, 2 items today) and every other section keep their
--     ids, so nothing under them moves.
--
-- Safe to re-run: inserts are keyed by slug, the delete is guarded, and the
-- renumber is idempotent.

-- 1. Retire Inbox — only if it is empty. Soft delete, so Restore works if
--    this was wrong.
update public.help_entries s
   set deleted_at = now(), updated_at = now()
 where s.kind = 'section'
   and s.slug = 'inbox'
   and s.deleted_at is null
   and not exists (
     select 1 from public.help_entries c
      where c.parent_id = s.id and c.deleted_at is null
   );

-- 2. Add the three missing sections.
insert into public.help_entries (kind, position, title, slug, tab_key, icon) values
  ('section', 3, 'Network',     'network',    'partners',   '👥'),
  ('section', 5, 'Back Office', 'back-office','backoffice', '🗂️'),
  ('section', 7, 'Admin',       'admin',      'admin',      '🏢')
on conflict (slug) do nothing;

-- 3. Renumber to the nav order.
update public.help_entries set position = v.pos, updated_at = now()
  from (values
    ('getting-started', 0),
    ('home',            1),
    ('clients',         2),
    ('network',         3),
    ('reports',         4),
    ('back-office',     5),
    ('settings',        6),
    ('admin',           7)
  ) as v(slug, pos)
 where help_entries.slug = v.slug
   and help_entries.kind = 'section';

-- 4. Read it back. Expect eight live sections in nav order, and Inbox with
--    a deleted_at. If Inbox shows live with children > 0, it was not empty:
--    move or delete its children from the Help editor first, then re-run.
select s.title, s.slug, s.position, s.deleted_at,
       (select count(*) from public.help_entries c where c.parent_id = s.id and c.deleted_at is null) as live_children
  from public.help_entries s
 where s.kind = 'section'
 order by s.deleted_at nulls first, s.position;
