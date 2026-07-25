-- ═══════════════════════════════════════════════════════════════════════════
-- lead_notification_global_cc — corporate oversight addresses that receive
-- EVERY lead notification at EVERY live location.
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Idempotent: safe to
-- re-run. Additive: one new table, nothing existing is touched.
--
-- WHY A DEDICATED TABLE. lead_notification_externals is location-keyed — a
-- global observer modeled there would be 54 duplicated rows that drift as
-- locations are added. This list is tenant-wide by definition, so it gets its
-- own (tiny) table.
--
-- DELIBERATELY NO category COLUMN. Global CC receives everything and is
-- IMMUNE to split-notification routing by definition — the app resolves this
-- list OUTSIDE resolveLeadRecipients (lib/notification-recipients.ts
-- resolveGlobalCcRecipients) precisely so it can never be filtered by project
-- type. A category column here would invite someone to wire it in.
--
-- HOW THE APP USES IT (already shipped, fail-soft — this table missing means
-- the feature is simply dark, no send is ever blocked):
--   • notifyNewLead merges active rows AFTER the notifications_live gate and
--     AFTER project-type routing. A muted location sends nothing to anyone,
--     global CC included.
--   • Addresses ride BCC, never the shared To line — the oversight list is
--     not visible to franchise recipients.
--   • An address matching an ACTIVE hub_user (disabled_at IS NULL) gets the
--     with-button variant; otherwise the no-button variant.
--   • active=false keeps the row (audit trail) but stops the emails —
--     preferred over delete for pause/resume.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.lead_notification_global_cc (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text        NOT NULL,
  name       text,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per address, case-insensitively — the send path collapses by
-- lowercased email, so two rows differing only in case could never both
-- receive and would just be a confusing UI state.
CREATE UNIQUE INDEX IF NOT EXISTS lead_notification_global_cc_email_key
  ON public.lead_notification_global_cc (lower(email));

-- ── RLS — super_admin only ──────────────────────────────────────────────────
-- This is a corporate oversight list: location owners/managers must not read
-- it (it is hidden from them in the emails themselves via BCC — the DB layer
-- must match). The send path reads via the service role, which bypasses RLS;
-- the future admin route enforces super_admin again server-side (route is the
-- primary gate, RLS is defense-in-depth — same model as
-- lead_notification_externals).
ALTER TABLE public.lead_notification_global_cc ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lead_notification_global_cc rw" ON public.lead_notification_global_cc;
CREATE POLICY "lead_notification_global_cc rw"
  ON public.lead_notification_global_cc FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND hub_users.role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND hub_users.role = 'super_admin'
    )
  );

COMMIT;

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name = 'lead_notification_global_cc';
-- SELECT policyname, tablename FROM pg_policies
--   WHERE tablename = 'lead_notification_global_cc';
-- Seed rows are Kevin's to add, e.g.:
--   INSERT INTO public.lead_notification_global_cc (email, name)
--   VALUES ('someone@bmave.com', 'Some One');
