-- migrations/jobber_session_b.sql
--
-- Schema for Send-to-Jobber (Session B). Adds columns the new endpoint
-- needs to write back to a lead after a successful Jobber API call.
--
-- All adds are idempotent — safe to re-run.
--
-- Run via Supabase SQL editor.

-- ─── leads: jobber sub-record IDs + status fields ────────────────────────────
-- jobber_client_id + jobber_synced_at already exist. The new columns mirror
-- the Deluge writeback (jobber_request_id, jobber_assessment_id, etc.).
-- Status is split into a freetext message + a coarse code for filtering.

alter table leads
  add column if not exists jobber_property_id   text,
  add column if not exists jobber_request_id    text,
  add column if not exists jobber_assessment_id text,
  add column if not exists jobber_job_id        text,
  add column if not exists jobber_sync_status   text,
  add column if not exists jobber_match_status  text;

-- jobber_match_status values: 'matched_existing' | 'new_client'
alter table leads drop constraint if exists leads_jobber_match_status_check;
alter table leads
  add constraint leads_jobber_match_status_check
  check (
    jobber_match_status is null
    or jobber_match_status in ('matched_existing', 'new_client')
  );

-- ─── hub_users.jobber_user_id ────────────────────────────────────────────────
-- Stores the team member's Jobber user ID (numeric text, like jobber_client_id)
-- for assignment when creating an assessment appointment.

alter table hub_users
  add column if not exists jobber_user_id text;
