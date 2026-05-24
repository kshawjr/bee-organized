-- migrations/jobber_session_c.sql
--
-- Schema for Jobber inbound webhook receiver (Session C). Adds the
-- denormalized lead-level columns the webhook handlers write to.
--
-- The sub-tables (quotes, jobs, invoices) remain the source of truth
-- for full history. These columns mirror the "most recent" / "current"
-- values for fast access from the lead row — used by the BeeHub UI,
-- the Outreach timeline (each event timestamp drives a distinct entry
-- even when the stage doesn't change), and report queries that don't
-- want to join 4 tables.
--
-- Note: 'Job in Progress' stage is owner-driven only — no webhook
-- transitions a lead into it. See lib/jobber-webhook-handlers.ts for
-- the full topic → stage map.
--
-- All adds are idempotent (IF NOT EXISTS) — safe to re-run.
--
-- Run via Supabase SQL editor.

-- ─── leads: jobber sub-record IDs (denormalized) ────────────────────────────
-- jobber_request_id / jobber_assessment_id / jobber_job_id already exist
-- (added in jobber_session_b.sql). Add the two missing IDs.

alter table leads
  add column if not exists jobber_quote_id   text,
  add column if not exists jobber_invoice_id text;

-- ─── leads: financial denormalizations ──────────────────────────────────────
-- Webhook handlers update these as QUOTE_*/INVOICE_* events arrive.

alter table leads
  add column if not exists estimate_amount numeric,  -- latest quote total
  add column if not exists balance_owing   numeric,  -- latest invoice balance
  add column if not exists paid_amount     numeric;  -- latest invoice paid amount

-- ─── leads: per-event timestamps (Outreach timeline granularity) ────────────
-- Each Jobber event populates its own timestamp column so the Outreach
-- timeline can render a distinct entry even when the stage doesn't
-- change (e.g. QUOTE_APPROVED keeps stage at 'Estimate Sent' but
-- stamps quote_approved_at; JOB_CREATE keeps stage at 'Estimate Sent'
-- but stamps job_created_at + scheduled_at).

alter table leads
  add column if not exists request_created_at timestamptz,  -- REQUEST_CREATE
  add column if not exists quote_created_at   timestamptz,  -- QUOTE_CREATE
  add column if not exists quote_sent_at      timestamptz,  -- QUOTE_SENT
  add column if not exists quote_approved_at  timestamptz,  -- QUOTE_APPROVED
  add column if not exists job_created_at     timestamptz,  -- JOB_CREATE
  add column if not exists job_completed_at   timestamptz,  -- JOB_COMPLETE
  add column if not exists scheduled_at       timestamptz,  -- job.startAt (from JOB_CREATE)
  add column if not exists invoice_created_at timestamptz,  -- INVOICE_CREATE
  add column if not exists invoice_paid_at    timestamptz;  -- INVOICE_PAID
