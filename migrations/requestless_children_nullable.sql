-- migrations/requestless_children_nullable.sql
--
-- Requestless-import gap (bc8e310): quotes/jobs created directly on a
-- Jobber client have no service request, so their rows must be able to
-- carry service_request_id NULL. Verified via PostgREST OpenAPI metadata
-- 2026-07-09: both columns are currently NOT NULL (zero null rows exist —
-- the import silently dropped every requestless node, so nothing ever
-- tried).
--
-- Line 3 (invoices.job_id) is OPTIONAL but recommended: the INVOICE_*
-- webhook client-fallback (handleInvoiceCore, pre-existing) passes
-- jobDbId null when an invoice arrives with no resolvable job — that
-- insert violates NOT NULL today, so the "existing" invoice fallback is
-- dead-on-arrival. Same failure family, one-line fix. Skip it if you'd
-- rather keep invoices job-anchored.
--
-- No data change, no index change, instant (metadata-only ALTER).
-- Run via Supabase SQL editor. Safe to re-run (DROP NOT NULL is idempotent).

alter table quotes alter column service_request_id drop not null;
alter table jobs   alter column service_request_id drop not null;
alter table invoices alter column job_id drop not null;  -- optional; see header
