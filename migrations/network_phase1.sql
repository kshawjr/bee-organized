-- Network Phase 1 — schema for the referral-relationship repository.
-- ═══════════════════════════════════════════════════════════════════════════
-- ⛔ REVIEW ARTIFACT — DO NOT RUN until Kevin approves. Apply via the Supabase
-- SQL editor as ONE transaction (paste the whole file; it is self-contained).
--
-- ORDER: run AFTER migrations/partners.sql and migrations/hive_clients_phase0.sql
-- (both long applied — partners/companies/touchpoints all exist in prod).
-- The five sections below are ordered so each is independent; nothing here
-- depends on an earlier section within this file.
--
-- DRY ANALYSIS (scripts/scan-network-phase1.mjs, run 2026-07-23 against prod):
--   partners 4 (3 live: 2 partner / 1 contact) · companies 0 · touchpoints 344
--   leads with a referrer: 3 (all kind='partner', all resolving)
--   partners with company_id set: 0 → dangling company_id: 0
--   touchpoint kinds:   stage_change 155 · system 136 · reach_out 31 · drip 22
--   touchpoint methods: null 163 · system 128 · call 24 · email 23 · sms 6
--   ⇒ every existing method value is inside the widened CHECK below; the FK in
--     section 2 has zero rows to conflict with. Both preconditions verified.
--
-- ── Section 1 safety: existing lead-touchpoint readers ──────────────────────
-- Every existing touchpoints reader filters .eq('lead_id', <uuid>)
-- (clients/[id]/profile, engagements/[id], HiveShell child fetches). Partner
-- touchpoints carry lead_id = NULL, and `lead_id = <uuid>` is FALSE for NULL —
-- partner rows can NEVER match a lead-scoped query. Readers are unaffected by
-- construction, and the XOR CHECK guarantees no row ever carries both ids.
-- The one writer (lib/touchpoints.ts) omits the partner_id key entirely on
-- lead inserts, so the lead write path is byte-identical to today's.
--
-- ── Method vocabulary (the union, and why) ──────────────────────────────────
-- DB CHECK today:      call · sms · email · system · call_prompt · in_person
-- Classic partner UI:  coffee · call · email · event · text · referral · thankyou
-- Union chosen:        call · sms · email · system · call_prompt · in_person
--                      · coffee · event · thank_you
-- Reconciliation: text→sms (same channel, DB name wins); call/email map 1:1;
-- coffee + event are genuinely new methods, added; thankyou is added as
-- 'thank_you' (snake_case like call_prompt/no_answer); 'referral' is
-- deliberately NOT a method — "they sent a client" is the referred lead row
-- itself (leads.referred_by_*), and rendering it from the real link instead of
-- a free-text log entry is the whole point of Phase 1.
--
-- ── partners.last_contacted_at: STORED, not derived (section 5) ─────────────
-- Recommendation considered both ways. Derived (max(occurred_at) per partner at
-- read time) is the purer shape, BUT PostgREST aggregates are disabled
-- project-wide on this instance (count()/max()/group-by all error with
-- "aggregate functions not allowed"); deriving across a partner LIST would need
-- either an RPC (more DDL) or an N+1 query per partner. So: a stored
-- timestamptz maintained by the ONE touchpoint writer (lib/touchpoints.ts
-- bumps it on partner reach_out inserts — the exact pattern the lead path
-- already uses to bump leads.updated_at). The column is a recomputable cache of
-- the touchpoint stream, never hand-written. The legacy free-text
-- partners.last_contact ('Apr 28', 'Just now') is left untouched; Phase 2 UI
-- reads last_contacted_at and treats the old column as display-only history.
--
-- ── ROLLBACK (reverse order; safe any time before partner touchpoints exist —
--    afterwards, step ① would orphan them, so delete partner rows first) ─────
--   ⑤ ALTER TABLE partners DROP COLUMN last_contacted_at;
--   ④ DROP INDEX idx_leads_referred_by;
--   ③ ALTER TABLE leads DROP CONSTRAINT leads_referred_by_kind_check;
--     ALTER TABLE leads ADD CONSTRAINT leads_referred_by_kind_check
--       CHECK (referred_by_kind IS NULL OR referred_by_kind IN ('partner','lead'));
--   ② ALTER TABLE partners DROP CONSTRAINT partners_company_id_fkey;
--   ① DELETE FROM touchpoints WHERE partner_id IS NOT NULL;
--     DROP INDEX idx_touchpoints_partner;
--     ALTER TABLE touchpoints DROP CONSTRAINT touchpoints_subject_xor_check;
--     ALTER TABLE touchpoints DROP CONSTRAINT touchpoints_method_check;
--     ALTER TABLE touchpoints ADD CONSTRAINT touchpoints_method_check
--       CHECK (method IS NULL OR method IN ('call','sms','email','system','call_prompt','in_person'));
--     ALTER TABLE touchpoints ALTER COLUMN lead_id SET NOT NULL;
--     ALTER TABLE touchpoints DROP COLUMN partner_id;
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. touchpoints: partners become a first-class touchpoint subject ───────
-- partner_id CASCADE mirrors lead_id's CASCADE: a purged partner takes its
-- touchpoint history with it (the recycle bin's soft-delete never triggers it).
ALTER TABLE touchpoints
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id) ON DELETE CASCADE;

ALTER TABLE touchpoints ALTER COLUMN lead_id DROP NOT NULL;

-- Exactly one subject, always. num_nonnulls counts non-null args, so this
-- rejects both the zero-subject row and the double-subject row.
ALTER TABLE touchpoints DROP CONSTRAINT IF EXISTS touchpoints_subject_xor_check;
ALTER TABLE touchpoints
  ADD CONSTRAINT touchpoints_subject_xor_check
  CHECK (num_nonnulls(lead_id, partner_id) = 1);

-- Widened method vocabulary (see header for the reconciliation).
ALTER TABLE touchpoints DROP CONSTRAINT IF EXISTS touchpoints_method_check;
ALTER TABLE touchpoints
  ADD CONSTRAINT touchpoints_method_check
  CHECK (method IS NULL OR method IN (
    'call', 'sms', 'email', 'system', 'call_prompt', 'in_person',
    'coffee', 'event', 'thank_you'
  ));

-- Partner timeline read path ("last N touchpoints for this partner"), the
-- partner-side twin of idx_touchpoints_lead. Partial: lead rows (all 344
-- existing ones) don't pay for it.
CREATE INDEX IF NOT EXISTS idx_touchpoints_partner
  ON touchpoints(partner_id, occurred_at DESC)
  WHERE partner_id IS NOT NULL;

-- ─── 2. partners.company_id: soft ref → real FK ─────────────────────────────
-- ON DELETE SET NULL — the behavior partners.sql always DOCUMENTED ("nulled if
-- the company row is deleted") but never enforced. A deleted company must not
-- take its people with it (they outlive the org), so not CASCADE.
-- Defensive NULL-out first so the FK can never fail on a dangling id. Dry
-- analysis found 0 rows with company_id at all, so this UPDATE touches nothing
-- today — it exists so the migration stays re-runnable and safe on any future
-- state, instead of failing.
UPDATE partners
SET company_id = NULL
WHERE company_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = partners.company_id);

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_company_id_fkey;
ALTER TABLE partners
  ADD CONSTRAINT partners_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;

-- ─── 3. referral source: companies join the kind enum ───────────────────────
-- referred_by_kind is a plain CHECK constraint (not a pg enum type), so
-- widening is drop + re-add — no type alteration, no table rewrite, and the
-- 3 existing 'partner' rows satisfy the new CHECK trivially. The polymorphic
-- resolvers (clients/[id]/profile, engagements/[id]) and the API validators
-- (POST /api/leads, PATCH /api/leads/[id]) learn 'company' in the same commit
-- that ships this file.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_referred_by_kind_check;
ALTER TABLE leads
  ADD CONSTRAINT leads_referred_by_kind_check
  CHECK (referred_by_kind IS NULL OR referred_by_kind IN ('partner', 'lead', 'company'));

-- ─── 4. reverse-referral index ──────────────────────────────────────────────
-- Backs GET /api/partners/[id]/referrals + /api/companies/[id]/referrals
-- ("every lead this realtor sent") — the query the Classic UI faked with a
-- client-side array scan. Partial: most leads have no referrer.
CREATE INDEX IF NOT EXISTS idx_leads_referred_by
  ON leads(referred_by_kind, referred_by_id)
  WHERE referred_by_id IS NOT NULL;

-- ─── 5. partners.last_contacted_at (stored cache — rationale in header) ─────
ALTER TABLE partners ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;

COMMIT;
