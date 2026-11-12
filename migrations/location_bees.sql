-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/location_bees.sql — the bee roster (Slack job channels, slice 2)
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN. Kevin runs it.
--
-- WHY. Owners will add and remove the bees working a job from that job's
-- Slack channel (slice 3). Bee Hub has never stored bees. This is a ROSTER,
-- not an account: a name and an email per location, typed by the owner. No
-- login, no password, no seat, no access control.
--
-- WHO WRITES IT: app/api/locations/[id]/bees (owner + manager of that
-- location, super_admin, admin), through lib/location-bees.ts.
--
-- location_uuid IS A UUID ON PURPOSE. It matches engagements.location_uuid
-- (and slack_cards, reminders, location_zips) — locations.id. It is NOT the
-- text-slug convention ('loc_kc') of the old location_jobber_users.location_id.
-- Do not "tidy" it into a slug column to match that table: the slug form has
-- no foreign key and nothing protects it.
--
-- NEVER DELETED. Removing a bee sets is_active=false and stamps removed_at; a
-- bee who comes back reactivates the SAME row, so their Slack id and history
-- survive. That is why the unique index has no is_active clause: one row per
-- person per location, ever.
--
-- slack_user_id / slack_checked_at: the bee's Slack id in THIS location's
-- workspace, found by users.lookupByEmail when the bee is added, when their
-- email changes, or when the owner taps "Check again". NULL id + a stamp =
-- looked, nobody in that Slack has this email. NULL stamp = not checked.
--
-- jobber_user_id: room for later. NOTHING WRITES IT.
--
-- If bees ever sign in, a bee becomes a lite_user (hub_users). This table
-- stays the roster; a hub_user_id column could link the two then. Nothing
-- here is built for it now.
--
-- NO POLICIES. RLS on with no policy: browser clients read nothing. The
-- service-role client (server code only) bypasses RLS. Same as slack_cards.
--
-- UNDO: migrations/location_bees_undo.sql drops the table (and every bee
-- typed in since — export first if any exist).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.location_bees (
  id            uuid primary key default gen_random_uuid(),
  -- locations.id, like engagements.location_uuid — NOT the slug. See header.
  location_uuid uuid not null references public.locations(id) on delete cascade,
  name          text not null,
  email         text not null,
  -- Room for a later Jobber link. Nothing writes this.
  jobber_user_id  text,
  slack_user_id   text,
  slack_checked_at timestamptz,
  is_active     boolean not null default true,
  removed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One row per person per location, EVER (no is_active clause: re-adding a
-- removed bee reactivates their row instead of making a second one).
create unique index if not exists location_bees_loc_email_uniq
  on public.location_bees (location_uuid, lower(email));

create index if not exists location_bees_loc_active_idx
  on public.location_bees (location_uuid) where is_active;

alter table public.location_bees enable row level security;

comment on table public.location_bees is
  'Bee roster: name + email per location, typed by the owner (no login). Never deleted; removed = is_active false. location_uuid is locations.id (uuid), like engagements — not a slug.';
comment on column public.location_bees.location_uuid is
  'locations.id (uuid), matching engagements.location_uuid. Deliberately NOT the slug form used by location_jobber_users.location_id.';
comment on column public.location_bees.jobber_user_id is
  'Reserved for a later Jobber link. Nothing writes it yet.';
