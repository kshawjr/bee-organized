-- ════════════════════════════════════════════════════════════════════════════
-- DRIP FOLLOWUP INFRASTRUCTURE — Welcome + Opportunity Stage scheduling
-- ════════════════════════════════════════════════════════════════════════════
--
-- Adds the persistence layer for two new email mechanisms that fire
-- *outside* the normal drip_paths flow:
--
--   1. Welcome Email — single template that auto-fires 24h after Email 1
--      of any new lead drip path. Tracked via two new columns on `leads`:
--        - welcome_email_scheduled_at  (when to fire — set by drip-send.ts
--          when Email 1 sends successfully)
--        - welcome_email_sent_at       (when it actually sent — set by the
--          cron when it picks the row up)
--
--   2. Opportunity Stages Drip — six templates that fire on lead.stage
--      transitions (Closed Won, Estimate Sent). Tracked via a new
--      scheduled_stage_emails queue table. Rows inserted by
--      applyDripSideEffects() in lib/drip-lifecycle.ts; consumed by the
--      hourly cron.
--
-- Idempotent.
--
-- DEPLOY ORDER:
--   1. drip_paths_is_master.sql
--   2. cleanup_legacy_drip_paths.sql
--   3. seed_master_drip_paths.sql
--   4. THIS file
--   5. Deploy code (lib/drip-send.ts welcome scheduling +
--      lib/drip-lifecycle.ts stage email scheduling + cron processing).
-- ════════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 1 — leads.welcome_email_* columns
-- ──────────────────────────────────────────────────────────────────────────
-- scheduled_at is set when Email 1 of a new lead drip fires.
-- sent_at is set when the cron actually sends the welcome.
-- Both NULL is the steady state (no welcome pending or sent).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS welcome_email_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at      timestamptz;

-- Cron hot path: "what welcome emails are due to send right now?"
CREATE INDEX IF NOT EXISTS idx_leads_welcome_due
  ON leads(welcome_email_scheduled_at)
  WHERE welcome_email_scheduled_at IS NOT NULL
    AND welcome_email_sent_at IS NULL;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 2 — scheduled_stage_emails table
-- ──────────────────────────────────────────────────────────────────────────
-- One row per (lead, stage_email_key) pair. Insert when a stage transition
-- triggers the rule; cron picks it up at send_at; cancel by setting
-- cancelled_at if the lead reverses out of the trigger stage before
-- send_at.
--
-- stage_email_key values match the templates.legacy_id for the email
-- to render (e.g. 'opp_closed_job_3mo', 'opp_organizing_estimate_30d').

CREATE TABLE IF NOT EXISTS scheduled_stage_emails (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  stage_email_key    text NOT NULL,
  send_at            timestamptz NOT NULL,
  sent_at            timestamptz,
  cancelled_at       timestamptz,
  cancelled_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, stage_email_key)
);

-- Cron hot path: "what stage emails are due to send right now?"
CREATE INDEX IF NOT EXISTS idx_scheduled_stage_emails_due
  ON scheduled_stage_emails(send_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- Cancellation lookup by lead_id (when stage transitions out of trigger
-- stage, cancel any pending scheduled rows).
CREATE INDEX IF NOT EXISTS idx_scheduled_stage_emails_lead
  ON scheduled_stage_emails(lead_id)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE scheduled_stage_emails ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_scheduled_stage_emails_updated_at ON scheduled_stage_emails;
CREATE TRIGGER trg_scheduled_stage_emails_updated_at
  BEFORE UPDATE ON scheduled_stage_emails
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ──────────────────────────────────────────────────────────────────────────
-- POST-RUN VERIFICATION (read-only)
-- ──────────────────────────────────────────────────────────────────────────
--   -- Welcome columns exist:
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'leads'
--     AND column_name IN ('welcome_email_scheduled_at', 'welcome_email_sent_at');
--
--   -- Table created with expected columns:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'scheduled_stage_emails'
--   ORDER BY ordinal_position;
--
--   -- Should be 0 before any sends:
--   SELECT count(*) FROM scheduled_stage_emails;
