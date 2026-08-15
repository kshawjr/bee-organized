-- ═══════════════════════════════════════════════════════════════════════════
-- Issue 296 — A JOB TYPE CAN SEND FROM A GROUP INBOX. Part 1: the migration.
--
-- APPLIED TO PRODUCTION 2026-08-15 — verified in the catalog: sender_is_custom
-- exists, boolean, NOT NULL, DEFAULT false, and all 5 rows are false. Recorded
-- here because every migration this project runs is tracked. Idempotent
-- (ADD COLUMN IF NOT EXISTS), but there is no reason to run it again.
--
-- ── THE MODEL (Kevin, 2026-08-15) ───────────────────────────────────────────
-- A job type's client emails very commonly come from a shared mailbox —
-- moving@beeorganized-kc.com — not a person. Per type there are now TWO
-- independent facts, not one:
--
--   WHO HANDLES IT   — a person. Drives assignment. STILL REQUIRED.
--   WHAT IT SENDS AS — that person's identity, OR a typed name + address with
--                      its own reply-to.
--
-- Before this, these were FUSED: sender_name/sender_email were, by convention,
-- a copy of the handler's hub_users row. Nothing in the schema said so — the
-- columns are plain text, snapshotted at assign time. Only the code and the
-- picker enforced the fusion.
--
-- ── WHY source_user_id STAYED NOT NULL ──────────────────────────────────────
-- The obvious move — drop the NOT NULL so a row can be a typed sender with no
-- person — cannot express the requirement. It gives you handler XOR typed
-- sender, and the feature needs handler AND typed sender: "Carol handles
-- Moving, and it sends as moving@". That is the shape loc_lakenorman already
-- runs at LOCATION level (From infolakenorman@, Reply-To krystal@); this makes
-- it sayable per JOB TYPE.
--
-- Nullable would also have cost the assignment: a type with a typed sender and
-- no person falls back to the location owner, quietly undoing issue 246 for
-- every type that adopted a group inbox. And it would have broken the liveness
-- gate in lib/project-type-handlers.ts, which filters handlers by hub_users
-- is_active/disabled_at — a row with no user cannot be gated that way. Every
-- row still names a person, so that filter needed no special case.
--
-- ── WHAT THIS COLUMN DOES, NOT OVERCLAIMED ──────────────────────────────────
-- It does not change send behaviour by itself: the send path reads
-- sender_name/sender_email either way. Its two jobs are
--   1. UI STATE — reproducing the owner's choice on reload. The alternative was
--      inferring the mode by comparing sender_email against the handler's live
--      hub_users.email, which breaks the moment that email changes: a
--      person-mode row starts reading as custom and the UI shows a typed
--      identity the owner never entered. Inferring a stated fact from a value
--      is the second-way-to-say-the-same-thing pattern issue 246 spent three
--      steps deleting.
--   2. Telling a future snapshot-refresh which rows it may safely touch.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES *NOT* DO ──────────────────────────
--   · sender_reply_to needs NO DDL. The column, the validator, the persist path
--     and the send-path reader all already existed. The only missing writer was
--     the UI, which is Part 2.
--   · NOTHING IS DROPPED. locations.split_senders_enabled and
--     split_notifications_enabled still await their Part 3 cleanup, and the
--     table is still not renamed — a rename breaks every deployed reader the
--     instant it runs.
--   · No CHECK on sender_reply_to's format. EMAIL_RE in the API route is the
--     right place; a DB-side email-format CHECK is a classic regret.
--
-- ── PRE-FLIGHT (verified against production 2026-08-15, before applying) ────
--   location_project_type_senders          5 rows (4 loc_kc, 1 loc_test)
--     · source_user_id IS NULL             0     (new_lead_handlers.sql applied)
--     · sender_reply_to IS NOT NULL        0     (all replies went to the location default)
--     · disabled/inactive handlers         0
--   No read of this table used SELECT * or a column-count assumption — all
--   three named their columns, so adding one was invisible to every deployed
--   reader. That is what made this runnable before OR after the Part 2 deploy.
-- ═══════════════════════════════════════════════════════════════════════════


begin;

-- ── What it sends as: the handler's own identity, or a typed one ────────────
--
-- DEFAULT false — all 5 existing rows are person-mode, which is exactly what
-- they were. This column changed nobody's mail on the day it ran.
--
-- false → sender_name/sender_email are the handler's identity, snapshotted
--         from hub_users. Prior behaviour, unchanged.
-- true  → sender_name/sender_email are a typed identity (a group inbox), and
--         sender_reply_to is the person who should receive the replies. The
--         handler in source_user_id still owns the ASSIGNMENT.
--
-- Deliberately NOT nullable and NOT three-valued: "unset" would be a third
-- state meaning the same as false, and re-open the inference problem this
-- column exists to close.

alter table public.location_project_type_senders
  add column if not exists sender_is_custom boolean not null default false;

comment on column public.location_project_type_senders.sender_is_custom is
  'Does this job type send as a TYPED identity rather than as its handler? (issue 296). false (default) = sender_name/sender_email are the handler''s own identity, copied from their hub_users row. true = they are a hand-typed name and address — a shared mailbox such as moving@beeorganized-kc.com — and sender_reply_to carries the person replies should reach. Either way source_user_id names the person who HANDLES the type and receives the assignment: what a type sends as and who works it are independent facts, and this column is what lets a row say both.';

commit;


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK.
--
-- begin;
-- alter table public.location_project_type_senders
--   drop column if exists sender_is_custom;
-- commit;
--
-- WHAT BREAKS IF THIS IS RUN AFTER ROWS CARRY A CUSTOM SENDER:
--
--   MAIL KEEPS WORKING. sender_name/sender_email still hold the typed identity
--   and lib/resend.ts reads those columns, not the flag. moving@ keeps sending
--   as moving@, and its reply-to survives in sender_reply_to. No drip is lost
--   and no From address changes at the moment of rollback.
--
--   THE CONFIGURATION IS LOST, IRRECOVERABLY. Which rows were custom is not
--   derivable afterwards — a typed identity is indistinguishable from a stale
--   person-snapshot.
--
--   THE LOSS SURFACES ON THE NEXT SAVE, NOT AT ROLLBACK. The Part 2 UI would
--   read a payload with no sender_is_custom, render every row as person mode,
--   and the next handler re-pick would overwrite moving@beeorganized-kc.com
--   with the person's own address and null the reply-to. Silently, some time
--   later, after an unrelated edit.
--
-- SNAPSHOT FIRST if rolling back late:
--   create table if not exists public.location_project_type_senders_296_backup as
--   select * from public.location_project_type_senders where sender_is_custom;
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Post-apply verification (run after) ─────────────────────────────────────
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_name='location_project_type_senders' and column_name='sender_is_custom';
--   -- expect: sender_is_custom | boolean | NO | false
-- select count(*) from public.location_project_type_senders;                        -- expect: 5 (unchanged)
-- select count(*) from public.location_project_type_senders where sender_is_custom; -- expect: 0
-- select is_nullable from information_schema.columns
--   where table_name='location_project_type_senders' and column_name='source_user_id';
--   -- expect: NO (unchanged — this migration must NOT have relaxed it)
