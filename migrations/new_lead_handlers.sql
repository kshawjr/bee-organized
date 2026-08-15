-- ═══════════════════════════════════════════════════════════════════════════
-- Issue 246 step 2 — NEW LEADS, REBUILT. Part 1: the migration.
--
-- APPLIED TO PRODUCTION 2026-08-15 — verified in the catalog: source_user_id is
-- NOT NULL, the FK is ON DELETE CASCADE, and ..._loc_type_ci_idx exists. Do NOT
-- run it again; it is idempotent but the optional backfill below is not part of
-- it and is still Kevin's separate call.
--
-- Schema only. Run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Wrapped in a single
-- transaction: the whole block rolls back if any statement errors. Idempotent
-- on re-run (IF NOT EXISTS / DROP ... IF EXISTS / guarded pre-checks).
--
-- Full analysis, per-location impact and the code-carry enumeration:
--   /tmp/246-step2.md
--
-- ── THE MODEL (Kevin, 2026-08-15) ───────────────────────────────────────────
-- Two INDEPENDENT things, today fused into one `category` field:
--
--   WHO HANDLES A JOB TYPE — one person per type. Their name goes on the
--     client's emails AND a new lead of that type is assigned to them. No row,
--     or a lead matching no type → the location owner. Single-select. (Several
--     people can be on one LEAD, but that is a fact about the lead, set on the
--     lead, not here.)
--
--   WHO IS TOLD ABOUT A NEW LEAD — per person, on or off. Nothing to do with
--     job types. Lynette can be told about every lead while Carol handles
--     moving. Someone can have an account and hear about nothing.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES *NOT* DO ──────────────────────────
-- It is much smaller than it looks like it should be, because most of the
-- model already exists in the schema and only the CODE fuses it:
--
--   · "who is told" is already `lead_notification_prefs.subscribed`. Adding a
--     `notify` column beside it would create two booleans that must never
--     disagree — the same mistake as two handler tables (see below). REUSED.
--   · "who handles" is already `location_project_type_senders`. Under Kevin's
--     model the sender and the assignee are the SAME person per job type, so a
--     second table would be two things that must never disagree. REUSED, with
--     the constraints tightened to match its new, larger job.
--
-- NOTHING IS DROPPED HERE. `category`, `split_notifications_enabled` and
-- `split_senders_enabled` all survive this migration untouched, even though
-- the finished model has no use for any of them. Dropping a column that
-- currently-deployed code reads turns a run-anytime migration into one with a
-- deploy-ordering hazard. They go in a Part 3 cleanup, after the Part 2 code
-- has shipped and the last reader is gone. Additive-only is what lets Kevin
-- run this at any moment relative to a deploy.
--
-- The table is NOT renamed for the same reason. `location_project_type_senders`
-- becomes a misnomer the day handlers drive assignment, and a rename is
-- cheapest now — but a rename breaks every deployed reader the instant it
-- runs, and a compatibility VIEW cannot stand in because PostgREST's
-- `on_conflict` upsert (lib/project-type-senders.ts assignSenderToTypes)
-- needs a real unique constraint, which a view has not got. Rename in Part 3,
-- in the same commit as the code.
--
-- ── PRE-FLIGHT (all verified against production 2026-08-15) ─────────────────
--   location_project_type_senders          5 rows  (4 loc_kc, 1 loc_test)
--     · source_user_id IS NULL             0 rows  → SET NOT NULL is safe
--     · orphaned source_user_id            0 rows  → FK re-add is safe
--     · (location_id, lower(project_type))
--       collisions                         0 rows  → the CI index will build
--   lead_notification_prefs                2 rows  (both loc_test)
--   lead_notification_externals           50 rows  (all category='all')
--
-- Re-run the pre-flight block below before applying; ABORT if any is non-zero.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 0. PRE-FLIGHT — run this FIRST, on its own. Every count must be 0. ──────
--
-- select 'null source_user_id'  as check, count(*) from public.location_project_type_senders where source_user_id is null
-- union all
-- select 'orphan source_user_id', count(*) from public.location_project_type_senders s
--   where s.source_user_id is not null
--     and not exists (select 1 from public.hub_users u where u.id = s.source_user_id)
-- union all
-- select 'case collisions', count(*) from (
--   select location_id, lower(project_type) from public.location_project_type_senders
--   group by 1,2 having count(*) > 1
-- ) x;


begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. WHO IS TOLD — give externals the on/off switch interface users already
--    have.
--
-- THE ONE GENUINE GAP in the current schema. lead_notification_prefs.subscribed
-- lets an owner mute a hub_user without deleting them; lead_notification_
-- externals has no equivalent, so the ONLY way to stop notifying an outside
-- address today is to DELETE the row — losing the record that they were ever
-- on the list, and guaranteeing the nightly Zoho top-up
-- (lib/zoho-recipient-topup.ts, cron 05:00) puts a Zoho-sourced address
-- straight back. "Per person, on or off" cannot be honestly built without this.
--
-- DEFAULT true — every one of the 50 existing rows is currently notified, and
-- stays notified. This column changes nobody's mail on the day it runs.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.lead_notification_externals
  add column if not exists subscribed boolean not null default true;

comment on column public.lead_notification_externals.subscribed is
  'Is this outside address told about new leads? Per person, on/off — the exact counterpart of lead_notification_prefs.subscribed, and NOT related to project type (issue 246 step 2). false mutes the address while keeping the row, so the nightly Zoho recipient top-up does not resurrect it and the owner can see who they muted. Default true: no existing recipient changes.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. WHO HANDLES — location_project_type_senders becomes the handler table.
--
-- It already holds exactly the right rows. loc_kc's four are Kevin's model
-- stated in data: Carol Kern handles Moving/Relocation; Lynette Ewy handles
-- Concierge Services, Home or Office Organizing and Other. What changes is
-- that these rows will now decide the ASSIGNEE as well as the sender.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 2a. A handler must be a PERSON, not an email address ────────────────────
--
-- You can send AS a hand-typed address, but you cannot ASSIGN A LEAD to one.
-- Today source_user_id is nullable (the UI permits a typed sender) and the FK
-- is ON DELETE SET NULL, which actively MANUFACTURES nulls: delete the hub_user
-- and the row survives, still sending as a person who no longer exists — and,
-- after Part 2, still claiming a job type it can no longer assign. That is a
-- row that can send but not assign: the same send/assign fusion split down the
-- middle, which is the bug class this whole rebuild exists to end.
--
-- CASCADE is the model-correct behaviour: the person goes, their claim on the
-- job type goes with them, and the type falls back to the location owner — the
-- documented default. Note hub_users removal is normally SOFT (disabled_at, see
-- app/api/hub_users/[id]/access/route.ts), so this fires only on a true hard
-- delete. Part 2 must ALSO treat a disabled handler as absent; that is a code
-- rule, not something a FK can express.

alter table public.location_project_type_senders
  drop constraint if exists location_project_type_senders_source_user_id_fkey;

alter table public.location_project_type_senders
  add constraint location_project_type_senders_source_user_id_fkey
  foreign key (source_user_id) references public.hub_users(id) on delete cascade;

alter table public.location_project_type_senders
  alter column source_user_id set not null;

comment on column public.location_project_type_senders.source_user_id is
  'The hub_user who HANDLES this job type at this location (issue 246 step 2): their name goes on the client emails AND new leads of this type are assigned to them. NOT NULL — an assignee must be a person, so a hand-typed sender is no longer a valid handler. ON DELETE CASCADE: the person goes, the claim goes, the type falls back to the location owner.';


-- ── 2b. Case-collision backstop ─────────────────────────────────────────────
--
-- Three different matching rules read this vocabulary today:
--   assign  lib/lead-assignment.ts canonicalProjectType() — trim +
--           case-insensitive against lookups, plus legacy 'moving'/'organizing'
--           aliases.
--   notify  lib/notification-project-types.ts categoryMatchesLead() —
--           sel.types.includes(leadProjectType). Exact, case-sensitive, no trim,
--           no alias.
--   send    lib/resend.ts resolveProjectTypeSenderOverride() —
--           .eq('project_type', projectType). Exact, case-sensitive, in SQL.
--
-- Part 2 collapses these to ONE rule: canonicalize the lead's project_type to a
-- lookups label at the boundary, then match exactly. That is a code decision.
-- What the DB can add is the guarantee the code rule depends on — that a
-- location cannot end up with 'Moving/Relocation' AND 'moving/relocation' as
-- two separate handler rows, which would make "one person per type" quietly
-- false and which nothing today prevents.
--
-- Added ALONGSIDE the existing UNIQUE (location_id, project_type), not instead
-- of it: PostgREST's on_conflict= takes column names, so replacing the plain
-- constraint with this functional index would break assignSenderToTypes'
-- upsert. Two constraints, no conflict, and no Part 2 code depends on this one
-- — it is a backstop that turns a silent duplicate into a loud 23505.

create unique index if not exists location_project_type_senders_loc_type_ci_idx
  on public.location_project_type_senders (location_id, lower(project_type));


-- ── 2c. Restate the table's job ─────────────────────────────────────────────

comment on table public.location_project_type_senders is
  'WHO HANDLES EACH JOB TYPE at a location (issue 246 step 2). One person per (location, project_type): their identity is the FROM on that type''s client emails, and a new lead of that type is assigned to them. No row for a type — or a lead matching no type — means the location owner. Named for its original narrower job (sender routing only); rename deferred to Part 3 so this migration stays additive and deploy-order-independent.';


commit;


-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL — legacy project_type backfill. RUN SEPARATELY, OR NOT AT ALL.
--
-- Two leads carry project_type='organizing', the pre-unification drip-category
-- token rather than a lookups label. Both are at loc_test. They are the ONLY
-- place the three matching rules visibly disagree today: assign aliases
-- 'organizing' → 'Home or Office Organizing' and routes it; notify and send do
-- not and fall through.
--
-- Part 2's single canonicalizer handles these rows correctly WITHOUT this
-- backfill — the alias table stays. This statement only lets that alias table
-- eventually die. It edits real lead rows, so it is Kevin's call, separately.
--
-- NOT INCLUDED and NOT fixable here: project_type='Client' (53 leads across 13
-- locations, 14 of them loc_kc). That is not a project type at all — it is what
-- the manual-create path writes. It canonicalizes to null and falls to the
-- owner under every rule, old and new, which is the correct outcome. Fixing the
-- manual-create path is its own issue.
--
-- Expected: UPDATE 2.
--
-- update public.leads
--    set project_type = 'Home or Office Organizing'
--  where project_type = 'organizing';


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — exact inverse. See /tmp/246-step2.md §6 for what breaks if this is
-- run AFTER the Part 2 feature ships (short version: any external the owner
-- muted starts receiving lead mail again, silently).
--
-- begin;
--
-- drop index if exists public.location_project_type_senders_loc_type_ci_idx;
--
-- alter table public.location_project_type_senders
--   alter column source_user_id drop not null;
--
-- alter table public.location_project_type_senders
--   drop constraint if exists location_project_type_senders_source_user_id_fkey;
-- alter table public.location_project_type_senders
--   add constraint location_project_type_senders_source_user_id_fkey
--   foreign key (source_user_id) references public.hub_users(id) on delete set null;
--
-- -- DESTRUCTIVE: discards every mute an owner has set on an outside address.
-- alter table public.lead_notification_externals drop column if exists subscribed;
--
-- commit;
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Post-apply verification (run after) ─────────────────────────────────────
-- select column_name, is_nullable, column_default from information_schema.columns
--   where table_name='lead_notification_externals' and column_name='subscribed';
--   -- expect: subscribed | NO | true
-- select count(*) from public.lead_notification_externals where subscribed = false;
--   -- expect: 0 (nobody muted on day one)
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conname='location_project_type_senders_source_user_id_fkey';
--   -- expect: FOREIGN KEY (source_user_id) REFERENCES hub_users(id) ON DELETE CASCADE
-- select is_nullable from information_schema.columns
--   where table_name='location_project_type_senders' and column_name='source_user_id';
--   -- expect: NO
-- select indexname from pg_indexes
--   where indexname='location_project_type_senders_loc_type_ci_idx';
--   -- expect: 1 row
-- select count(*) from public.location_project_type_senders;  -- expect: 5 (unchanged)
-- select count(*) from public.lead_notification_prefs;        -- expect: 2 (unchanged)
