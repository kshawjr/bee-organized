-- ═══════════════════════════════════════════════════════════════════════════
-- Per-project-type drip SENDER routing — location_project_type_senders.
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Idempotent: CREATE TABLE
-- / ADD COLUMN IF NOT EXISTS, safe to re-run.
--
-- MODEL. Post-B4 a location's client drips send from ONE base sender
-- (locations.send_from_email / sender_name / reply_to_email). This lets an
-- owner SPLIT the sender by the lead's PROJECT TYPE:
--
--   DEFAULT  → base sender handles every project type (single-person location
--              needs zero config; split_senders_enabled = false).
--   SPLIT    → split_senders_enabled = true, and specific project types are
--              assigned to a specific sender (a person picked from the
--              location's hub_users — name+email copied here). A sender can own
--              MANY types (many rows sharing sender_email); a type maps to at
--              most ONE sender (the UNIQUE below).
--
-- NEVER-DROP. Any project type WITHOUT a row — or the whole split disabled, or
-- this table / the flag not present yet (migration not run) — falls back to the
-- base sender. A drip is NEVER dropped for want of a per-type sender. The send
-- path (lib/resend.ts resolveProjectTypeSenderOverride) resolves this
-- defensively, so the routing code is SAFE TO SHIP BEFORE this migration runs.
--
-- FUTURE (do NOT build now). Multiple senders per type / rule-based routing can
-- be added later WITHOUT a destructive migration: drop the UNIQUE and add a
-- priority/rule column. Nothing here bakes in single-sender-only assumptions
-- beyond that one constraint.
--
-- location_id TYPE — TEXT, matching hub_users.location_id (TEXT holding the
-- location UUID string; verified in prod 2026-07-03, see
-- migrations/engagement_assignees.sql). The RLS check compares
-- hub_users.location_id = this.location_id as TEXT = TEXT — NO ::text cast
-- needed (a cast is only required when the other side is a uuid column).
--
-- PERMISSION MODEL — owner + corporate ONLY, manager/lite DENIED. Identical to
-- lead_notification_recipients: elevated (super_admin/admin) touch any
-- location; a franchise OWNER touches only their own; MANAGER + lite_user are
-- denied on read AND write. RLS enforces at the DB layer; the API route
-- enforces again server-side (service role bypasses RLS, so the route is the
-- primary gate — RLS is defense-in-depth).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Split toggle on the location ─────────────────────────────────────────
alter table public.locations
  add column if not exists split_senders_enabled boolean not null default false;

comment on column public.locations.split_senders_enabled is
  'When true, client drips route their FROM sender by the lead project_type via location_project_type_senders (unassigned types → base sender). When false (default), the base sender handles every type.';

-- ── 2. Per-type sender assignments ──────────────────────────────────────────
create table if not exists public.location_project_type_senders (
  id              uuid        primary key default gen_random_uuid(),
  location_id     text        not null,
  project_type    text        not null,
  sender_name     text        not null,
  sender_email    text        not null,
  sender_reply_to text,
  -- The hub_user this sender was picked from, if any. ON DELETE SET NULL — the
  -- assignment survives (name/email are copied) if the user is later removed,
  -- but we drop the dangling link. Nullable so a hand-typed sender is allowed.
  source_user_id  uuid        references public.hub_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One sender per (location, project_type) FOR NOW. Reassigning a type upserts
  -- this row (onConflict). Drop this to allow multiple-senders-per-type later.
  unique (location_id, project_type)
);

create index if not exists location_project_type_senders_location_idx
  on public.location_project_type_senders (location_id);

-- ── 3. RLS — owner + elevated only, manager/lite denied, location-scoped ─────
alter table public.location_project_type_senders enable row level security;

drop policy if exists "location_project_type_senders rw" on public.location_project_type_senders;
create policy "location_project_type_senders rw"
  on public.location_project_type_senders for all to authenticated
  using (
    exists (
      select 1 from public.hub_users
      where hub_users.id = auth.uid()
        and (
          hub_users.role in ('super_admin', 'admin')
          or (hub_users.role = 'owner'
              and hub_users.location_id = location_project_type_senders.location_id)
        )
    )
  )
  with check (
    exists (
      select 1 from public.hub_users
      where hub_users.id = auth.uid()
        and (
          hub_users.role in ('super_admin', 'admin')
          or (hub_users.role = 'owner'
              and hub_users.location_id = location_project_type_senders.location_id)
        )
    )
  );

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='locations' AND column_name='split_senders_enabled';
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name='location_project_type_senders';
-- SELECT policyname FROM pg_policies WHERE tablename='location_project_type_senders';
