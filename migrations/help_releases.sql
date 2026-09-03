-- ════════════════════════════════════════════════════════════════════
--  What's new — the weekly release note. Two tables, no bucket.
--  Apply via the Supabase SQL editor. Kevin runs it; the code never does.
-- ════════════════════════════════════════════════════════════════════
--
-- What this does, in order:
--   1. Creates public.help_releases — one row per week. The week runs
--      FRIDAY to THURSDAY and the note goes out on the Thursday. Exactly
--      one row may be 'draft' at a time (partial unique index), so two
--      Fixed marks in the same second cannot open two weeks.
--   2. Creates public.help_release_items — the lines in a release, grouped
--      new / changed / fixed. An item seeded from a feedback entry carries
--      that entry's id as PROVENANCE ONLY (feedback_item_id): nothing here
--      is ever written back to feedback_items, and the FK is ON DELETE SET
--      NULL so deleting a report never deletes a line. The unique index on
--      feedback_item_id INCLUDES soft-deleted rows on purpose — a line
--      Kevin removed stays removed if the entry is un-fixed and re-fixed.
--      edited_at is NULL until an editor saves the line once: a NULL
--      edited_at means "still in the owner's words", and such a line is
--      never shown to owners and never posted to Slack.
--   3. Row-level security: any signed-in user reads PUBLISHED releases and
--      their edited, undeleted items; super_admin/admin (the corp tier the
--      UI calls "Corporate") read everything and are the only writers.
--
-- feedback_items, feedback_replies and help_entries are NOT altered by
-- this file. The only mention of feedback_items is the foreign key.
--
-- Deploy order: the code is safe BEFORE or AFTER this runs. Until the
-- tables exist the What's new tab shows "Nothing here yet", the editor
-- says the migration hasn't been run, and marking a feedback entry Fixed
-- behaves exactly as today (the seed insert fails quietly and is logged).

-- ─── 1. releases ─────────────────────────────────────────────────────

create table if not exists public.help_releases (
  id            uuid primary key default gen_random_uuid(),
  -- the Friday the week starts and the Thursday it ends (= the day the
  -- note is meant to go out). Dates, not timestamps: a week is a label.
  week_start    date not null,
  publish_on    date not null,
  status        text not null default 'draft' check (status in ('draft','published')),
  summary       text,
  published_at  timestamptz,
  -- the Slack post, as sent, and when. NULL slack_posted_at on a published
  -- release means the post did not go (slack_error says why) or Kevin
  -- chose Help only.
  slack_text      text,
  slack_posted_at timestamptz,
  slack_error     text,
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint help_releases_week_rule check (publish_on = week_start + 6)
);

-- ONE open draft at a time.
create unique index if not exists help_releases_one_draft_idx
  on public.help_releases ((status)) where status = 'draft';

create index if not exists help_releases_published_idx
  on public.help_releases (published_at desc) where status = 'published';

-- ─── 2. items ────────────────────────────────────────────────────────

create table if not exists public.help_release_items (
  id               uuid primary key default gen_random_uuid(),
  release_id       uuid not null references public.help_releases(id) on delete cascade,
  "group"          text not null check ("group" in ('new','changed','fixed')),
  title            text not null,
  body             text,
  -- optional link to a Help topic (the picker is part 2; the column is here
  -- so part 2 is UI only)
  help_entry_id    uuid references public.help_entries(id) on delete set null,
  -- provenance: the feedback entry this line was seeded from, if any
  feedback_item_id uuid references public.feedback_items(id) on delete set null,
  -- NULL = still in the owner's words. Stamped on the first editor save.
  edited_at        timestamptz,
  position         integer not null default 0,
  deleted_at       timestamptz,
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One line per feedback entry, EVER — deleted rows included (see header).
create unique index if not exists help_release_items_feedback_idx
  on public.help_release_items (feedback_item_id) where feedback_item_id is not null;

create index if not exists help_release_items_release_idx
  on public.help_release_items (release_id, position);

-- ─── 3. row-level security ───────────────────────────────────────────

alter table public.help_releases enable row level security;
alter table public.help_release_items enable row level security;

drop policy if exists "help_releases_select" on public.help_releases;
create policy "help_releases_select"
  on public.help_releases for select to authenticated
  using (
    status = 'published'
    or exists (
      select 1 from public.hub_users
      where hub_users.id = auth.uid()
        and hub_users.role in ('super_admin','admin')
    )
  );

drop policy if exists "help_releases_write_editors" on public.help_releases;
create policy "help_releases_write_editors"
  on public.help_releases for all to authenticated
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

drop policy if exists "help_release_items_select" on public.help_release_items;
create policy "help_release_items_select"
  on public.help_release_items for select to authenticated
  using (
    (
      deleted_at is null
      and edited_at is not null
      and exists (
        select 1 from public.help_releases r
        where r.id = help_release_items.release_id and r.status = 'published'
      )
    )
    or exists (
      select 1 from public.hub_users
      where hub_users.id = auth.uid()
        and hub_users.role in ('super_admin','admin')
    )
  );

drop policy if exists "help_release_items_write_editors" on public.help_release_items;
create policy "help_release_items_write_editors"
  on public.help_release_items for all to authenticated
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
