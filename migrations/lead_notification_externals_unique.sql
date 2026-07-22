-- ═══════════════════════════════════════════════════════════════════════════
-- lead_notification_externals — per-location UNIQUE (location_id, email).
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Idempotent: guarded with
-- IF NOT EXISTS / IS DISTINCT FROM, safe to re-run.
--
-- WHY. lead_notification_externals had only PK(id) + a NON-unique index on
-- location_id — no uniqueness on (location_id, email). Application-level
-- read-then-diff dedup (lib/zoho-recipient-topup.ts) was the ONLY guard, and it
-- lapsed: the nightly zoho-recipient-topup cron, pinned to a stale deployment,
-- appended a full fresh copy of every location's Zoho contacts every night from
-- 2026-07-17 onward → 248 duplicate rows across 47 locations (310 total, every
-- distinct recipient ×5). This index is the STRUCTURAL backstop so a future app
-- lapse cannot recreate the duplication.
--
-- ── REQUIRED ORDER — READ BEFORE RUNNING ────────────────────────────────────
--   1. DEDUPE FIRST. Run the cleanup DELETE (see
--      scripts/dedupe-notification-externals.mjs, Kevin-approved) so at most one
--      row remains per (location_id, lower(email)). A UNIQUE index CANNOT be
--      created while the 248 duplicates exist — CREATE UNIQUE INDEX would error
--      on the first collision. Expected post-cleanup count: 62 rows.
--   2. THEN run THIS migration.
--   3. The app code (POST/PATCH routes + commitTopUpPlan) already ships ahead of
--      this and does NOT use ON CONFLICT — it dedups application-side and treats
--      a 23505 from this index as benign — so there is NO window where the app
--      errors whether this index exists or not. Order 1→2 is about the DDL
--      succeeding, not about app safety.
--
-- ── SHAPE ───────────────────────────────────────────────────────────────────
--   · PER-LOCATION COMPOSITE, not global: (location_id, email). The SAME address
--     may be a recipient at multiple locations — only WITHIN a location is it
--     unique. (Same lesson as the jobber_*_id composites.)
--   · Plain columns, NOT an expression index on lower(email): the app now STORES
--     email lowercased on every write (POST/PATCH routes + planLocationRows), so
--     a plain (location_id, email) unique enforces case-insensitivity without an
--     expression index — and keeps the door open to ON CONFLICT later (PostgREST
--     cannot arbitrate an expression/partial index; see the assessments-dedup
--     precedent).
--   · location_id is TEXT (holds the location UUID string; verified in prod, see
--     migrations/lead_notification_recipients.sql). email is TEXT. The index is
--     over the table's own text columns — no ::text cast needed (the cast is only
--     required when comparing hub_users.location_id against a uuid column, which
--     this migration does not do). RLS is unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Normalize any stray mixed-case/whitespace emails to lowercase ────────
-- Safety net so the plain (location_id, email) unique enforces case-insensitivity
-- for rows written before the app started lowercasing. SAFE only after step 1
-- (dedupe): the cleanup already collapsed each (location_id, lower(email)) group
-- to one row, so lowercasing here cannot itself create a new collision. (On
-- current prod data this is a no-op — all surviving rows are already lowercase.)
update public.lead_notification_externals
   set email = lower(btrim(email))
 where email is distinct from lower(btrim(email));

-- ── 2. The per-location composite unique backstop ──────────────────────────
-- A UNIQUE INDEX (not a named constraint) so IF NOT EXISTS makes re-runs a no-op.
-- Inferable by ON CONFLICT (location_id, email) if a future path ever wants it.
create unique index if not exists lead_notification_externals_location_email_key
  on public.lead_notification_externals (location_id, email);

comment on index public.lead_notification_externals_location_email_key is
  'Per-location uniqueness of notification recipients: at most one external row '
  'per (location_id, email). email is stored lowercased by the app, so this is '
  'effectively case-insensitive. Backstop for the application-side read-then-diff '
  'dedup — prevents recurrence of the 2026-07 nightly-cron duplication.';

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- Expect the index to exist and zero remaining duplicate groups:
-- SELECT indexname FROM pg_indexes
--   WHERE tablename = 'lead_notification_externals'
--     AND indexname = 'lead_notification_externals_location_email_key';
-- SELECT location_id, lower(email) AS email, count(*)
--   FROM public.lead_notification_externals
--   GROUP BY location_id, lower(email) HAVING count(*) > 1;   -- expect 0 rows
-- SELECT count(*) FROM public.lead_notification_externals;    -- expect 62
