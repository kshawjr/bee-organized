-- migrations/onboarding_persistence.sql
-- Task 4 Pass 1 — Onboarding writes to Supabase
--
-- Adds:
--   1. locations.onboarding_state (jsonb) — cached step-completion state for
--      fast page-load read. Shape:
--        { completedSteps: {welcome:true,pay:true,...},
--          activeStepOpen:  'paths' | null,
--          lastUpdated:     timestamptz }
--   2. locations.default_drip_path / default_move_drip_path (text) — drip
--      path persistence for the Settings > Paths tab and the onboarding
--      'paths' step. Matches the existing module-level _defaultPathId /
--      _defaultMovePathId vars in BeeHub.jsx.
--   3. onboarding_progress (new table) — audit log of every step completion
--      keyed by auth.users.id. user_id (not hub_users.id) so we can track
--      onboarding flows for invited team members BEFORE they have a
--      hub_users row (future employee_setup flow).
--
-- Reset: clears onboarding_state for all in-flight onboarders (Test Location
-- + 10 launch partners). Safe to re-run; idempotent.

-- ─── 1. locations columns ───────────────────────────────────────────────────
alter table locations
  add column if not exists onboarding_state       jsonb default '{}'::jsonb,
  add column if not exists default_drip_path      text  default 'general-a',
  add column if not exists default_move_drip_path text  default 'move-a';

-- ─── 2. onboarding_progress audit table ─────────────────────────────────────
create table if not exists onboarding_progress (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  location_id     uuid          references locations(id) on delete cascade,
  onboarding_type text not null default 'owner_setup',
  step            text not null,
  completed_at    timestamptz not null default now(),
  completed_by    uuid          references auth.users(id),
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (user_id, onboarding_type, step)
);

create index if not exists onboarding_progress_location_idx
  on onboarding_progress (location_id);
create index if not exists onboarding_progress_user_type_idx
  on onboarding_progress (user_id, onboarding_type);

-- RLS: enabled, no client-side policies. All reads/writes go through API
-- routes using service-role client (matches subscription_seats pattern).
alter table onboarding_progress enable row level security;

-- ─── 3. Reset in-flight onboarders ──────────────────────────────────────────
-- Test Location + the 10 Wednesday launch partners. Wipes cached step state
-- so they restart fresh on first login post-migration. onboarding_progress
-- is new so there's nothing to clear there.
update locations
   set onboarding_state = '{}'::jsonb
 where lifecycle_status = 'onboarding';
