-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/engagement_bees.sql — which bees are on which job
-- (Slack job channels, slice 3 of 3, part A)
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN. Kevin runs it. Needs migrations/location_bees.sql
-- first (the foreign key points at it).
--
-- WHY. The roster (location_bees) says who a location's bees are. Nothing
-- said who is on which job. The Bees cell on the engagement panel writes
-- here, and when the job has a Slack channel each tick / untick is mirrored
-- into it (lib/engagement-bees.ts).
--
-- BEES ARE NOT ASSIGNEES. engagement_assignees is hub users (logins) and
-- drives the Jobber crew sync. This table is the bee roster (no logins) and
-- drives Slack only. Nothing writes both.
--
-- NEVER DELETED. Unassigning stamps removed_at; reassigning clears it. Who
-- was on a job is worth keeping, and it keeps the unique index simple (one
-- row per bee per job, ever).
--
-- Only bees of the engagement's own location may be assigned — enforced in
-- app/api/engagements/[id]/bees, not here (a check across two tables).
--
-- NO POLICIES. RLS on with no policy: browser clients read nothing; the
-- service-role client (server code only) bypasses RLS. Same as location_bees.
--
-- Touches no existing row. Safe to re-run.
-- UNDO: migrations/engagement_bees_undo.sql (drops the table and every
-- assignment made since — export first if any exist).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.engagement_bees (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references public.engagements(id) on delete cascade,
  bee_id        uuid not null references public.location_bees(id) on delete cascade,
  assigned_at   timestamptz not null default now(),
  removed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists engagement_bees_uniq
  on public.engagement_bees (engagement_id, bee_id);

create index if not exists engagement_bees_live_idx
  on public.engagement_bees (engagement_id) where removed_at is null;

alter table public.engagement_bees enable row level security;

comment on table public.engagement_bees is
  'Which roster bees (location_bees) are on which engagement. Never deleted: unassign stamps removed_at. Not assignees — no Jobber sync; mirrored to the job''s Slack channel.';
