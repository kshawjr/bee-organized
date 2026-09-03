-- ════════════════════════════════════════════════════════════════════
--  Help section — one table, one bucket, six seeded sections.
--  Apply via the Supabase SQL editor. Kevin runs it; the code never does.
-- ════════════════════════════════════════════════════════════════════
--
-- What this does, in order:
--   1. Creates public.help_entries — sections, topics and items in ONE
--      table, told apart by `kind` and linked by `parent_id`.
--   2. Turns on row-level security: any signed-in user reads PUBLISHED,
--      undeleted rows; super_admin/admin (the corp tier the UI calls
--      "Corporate") read everything and are the only writers.
--   3. Creates the PUBLIC storage bucket `help-media` for videos and
--      screenshots (100 MB per file, video + image types only). No
--      storage.objects policies: uploads go through a signed upload URL
--      minted server-side for editors only, reads are public URLs.
--   4. Seeds the six starting sections, once (safe to re-run).
--
-- guide_slides and manual_slides are NOT touched by this file.
--
-- Deploy order: the code is safe BEFORE or AFTER this runs. Until the
-- table exists the Help tab shows "Nothing here yet" and the add form
-- reports "Help isn't set up yet"; nothing 500s.

-- ─── 1. the table ────────────────────────────────────────────────────

create table if not exists public.help_entries (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('section','topic','item')),
  parent_id   uuid references public.help_entries(id) on delete cascade,
  position    integer not null default 0,
  title       text not null,
  -- sections only: a stable handle for the seeded rows, and the app tab
  -- the section mirrors (null for Getting started, which mirrors no tab)
  slug        text unique,
  tab_key     text,
  icon        text,
  -- items only
  lead        text,
  media_kind  text check (media_kind in ('video','image')),
  media_path  text,
  steps       jsonb not null default '[]'::jsonb,
  callout     text,
  -- draft items are invisible to owners; sections/topics are always
  -- 'published' (an empty one is hidden from owners by the reader instead)
  status      text not null default 'published' check (status in ('draft','published')),
  -- soft delete: recoverable from the editor's "Deleted" list
  deleted_at  timestamptz,
  created_by  uuid references auth.users(id),
  updated_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint help_entries_parent_rule check (
    (kind = 'section' and parent_id is null) or (kind <> 'section' and parent_id is not null)
  ),
  constraint help_entries_media_pair check (
    (media_kind is null and media_path is null) or (media_kind is not null and media_path is not null)
  )
);

create index if not exists help_entries_parent_position_idx
  on public.help_entries (parent_id, position);

-- ─── 2. row-level security ──────────────────────────────────────────

alter table public.help_entries enable row level security;

drop policy if exists "help_entries_select" on public.help_entries;
create policy "help_entries_select"
  on public.help_entries for select to authenticated
  using (
    (deleted_at is null and status = 'published')
    or exists (
      select 1 from public.hub_users
      where hub_users.id = auth.uid()
        and hub_users.role in ('super_admin','admin')
    )
  );

drop policy if exists "help_entries_insert_editors" on public.help_entries;
create policy "help_entries_insert_editors"
  on public.help_entries for insert to authenticated
  with check (exists (
    select 1 from public.hub_users
    where hub_users.id = auth.uid()
      and hub_users.role in ('super_admin','admin')
  ));

drop policy if exists "help_entries_update_editors" on public.help_entries;
create policy "help_entries_update_editors"
  on public.help_entries for update to authenticated
  using (exists (
    select 1 from public.hub_users
    where hub_users.id = auth.uid()
      and hub_users.role in ('super_admin','admin')
  ))
  with check (exists (
    select 1 from public.hub_users
    where hub_users.id = auth.uid()
      and hub_users.role in ('super_admin','admin')
  ));

drop policy if exists "help_entries_delete_editors" on public.help_entries;
create policy "help_entries_delete_editors"
  on public.help_entries for delete to authenticated
  using (exists (
    select 1 from public.hub_users
    where hub_users.id = auth.uid()
      and hub_users.role in ('super_admin','admin')
  ));

-- ─── 3. the media bucket ────────────────────────────────────────────
-- PUBLIC: how-to videos of the app are not sensitive, every signed-in
-- user may see them, and a public URL lets the <video> tag stream with
-- range requests and browser caching — a signed URL expires mid-playback.
-- Object paths carry a random uuid, so a URL is unguessable.
-- 100 MB cap per file; the app also refuses videos over two minutes.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'help-media', 'help-media', true, 104857600,
  array['video/mp4','video/quicktime','video/webm','image/png','image/jpeg','image/webp','image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ─── 4. the six starting sections ───────────────────────────────────
-- Keyed by slug so re-running this file adds nothing twice.

insert into public.help_entries (kind, position, title, slug, tab_key, icon) values
  ('section', 0, 'Getting started', 'getting-started', null,       '🚀'),
  ('section', 1, 'Home',            'home',            'home',     '🏠'),
  ('section', 2, 'Inbox',           'inbox',           'hive',     '📥'),
  ('section', 3, 'Clients',         'clients',         'hive',     '🐝'),
  ('section', 4, 'Reports',         'reports',         'reports',  '📊'),
  ('section', 5, 'Settings',        'settings',        'settings', '⚙️')
on conflict (slug) do nothing;
