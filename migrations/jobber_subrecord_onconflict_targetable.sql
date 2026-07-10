-- Make quotes/jobs/invoices dedup indexes ON CONFLICT-targetable
--
-- Prerequisite for migrating upsertQuote/upsertJob/upsertInvoice from
-- check-then-insert to PostgREST idempotent upserts (the assessments
-- pattern, f0068c9). The existing indexes from
-- jobber_subrecord_location_scope_unique.sql are PARTIAL
-- (WHERE jobber_<x>_id IS NOT NULL), and Postgres only infers a partial
-- unique index as the ON CONFLICT arbiter when the conflict clause
-- repeats the index predicate — which PostgREST's on_conflict param
-- never emits. Targeting them as-is fails every sync with 42P10 (the
-- same gotcha the assessments index deliberately avoided; see
-- assessments_service_request_unique.sql).
--
-- Swap each to a NON-partial unique index on the same columns.
-- Semantics are unchanged:
--   * Non-NULL (location_id, jobber_<x>_id) pairs: already unique under
--     the partial index, so the new CREATE cannot fail on existing data.
--   * NULL jobber ids: default NULLS DISTINCT means NULL rows never
--     collide — identical to the partial index excluding them. (Prod has
--     ZERO null jobber ids in all three tables anyway; scanned 7/9/26.)
--
-- Each swap creates the replacement first, drops the partial one, then
-- renames — uniqueness is enforced at every point in between, and the
-- final name matches what jobber_subrecord_location_scope_unique.sql
-- created, so its IF NOT EXISTS stays a no-op if ever re-run.
--
-- service_requests_location_jobber_request_id_idx is deliberately NOT
-- touched: upsertServiceRequest isn't being migrated to onConflict in
-- this pass, so its partial index keeps working as a throwing backstop.
--
-- ─── PRE-FLIGHT: must return zero rows each (verified 7/9/26) ────────
-- SELECT location_id, jobber_quote_id, count(*) FROM quotes
--   WHERE jobber_quote_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- SELECT location_id, jobber_job_id, count(*) FROM jobs
--   WHERE jobber_job_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- SELECT location_id, jobber_invoice_id, count(*) FROM invoices
--   WHERE jobber_invoice_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;

-- quotes ─────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX quotes_location_jobber_quote_id_full_idx
  ON quotes (location_id, jobber_quote_id);
DROP INDEX IF EXISTS quotes_location_jobber_quote_id_idx;
ALTER INDEX quotes_location_jobber_quote_id_full_idx
  RENAME TO quotes_location_jobber_quote_id_idx;

-- jobs ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX jobs_location_jobber_job_id_full_idx
  ON jobs (location_id, jobber_job_id);
DROP INDEX IF EXISTS jobs_location_jobber_job_id_idx;
ALTER INDEX jobs_location_jobber_job_id_full_idx
  RENAME TO jobs_location_jobber_job_id_idx;

-- invoices ───────────────────────────────────────────────────────────
CREATE UNIQUE INDEX invoices_location_jobber_invoice_id_full_idx
  ON invoices (location_id, jobber_invoice_id);
DROP INDEX IF EXISTS invoices_location_jobber_invoice_id_idx;
ALTER INDEX invoices_location_jobber_invoice_id_full_idx
  RENAME TO invoices_location_jobber_invoice_id_idx;

-- ─── POST-FLIGHT: expect exactly one row per table, indisunique=t, ───
-- ─── indpred IS NULL (non-partial) ───────────────────────────────────
-- SELECT c.relname AS index_name, i.indisunique, i.indpred IS NOT NULL AS is_partial
-- FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
-- WHERE c.relname IN (
--   'quotes_location_jobber_quote_id_idx',
--   'jobs_location_jobber_job_id_idx',
--   'invoices_location_jobber_invoice_id_idx'
-- );
