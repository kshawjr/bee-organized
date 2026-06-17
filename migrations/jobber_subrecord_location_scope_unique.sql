-- Defense-in-depth: scope Jobber sub-record dedup by location
--
-- Today these work because Jobber resource IDs are globally unique
-- across all Jobber accounts. But if a regression ever cross-wired
-- dedup, the DB now physically prevents the same Jobber ID landing
-- twice under the same location. Index on (location_id,
-- jobber_<x>_id) also speeds up the per-location lookups the code
-- now uses.

-- ─── PRE-FLIGHT: check for existing collisions ──────────────────────
-- Run these BEFORE creating the indexes — if any return rows, the
-- CREATE UNIQUE INDEX will fail because the table has duplicates.
-- Currently expected: ZERO collisions (audited 6/17/26 at 05d11bf).
--
-- SELECT location_id, jobber_request_id, count(*) FROM service_requests
--   WHERE jobber_request_id IS NOT NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
-- SELECT location_id, jobber_quote_id, count(*) FROM quotes
--   WHERE jobber_quote_id IS NOT NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
-- SELECT location_id, jobber_job_id, count(*) FROM jobs
--   WHERE jobber_job_id IS NOT NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
-- SELECT location_id, jobber_invoice_id, count(*) FROM invoices
--   WHERE jobber_invoice_id IS NOT NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS service_requests_location_jobber_request_id_idx
  ON service_requests (location_id, jobber_request_id)
  WHERE jobber_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_location_jobber_quote_id_idx
  ON quotes (location_id, jobber_quote_id)
  WHERE jobber_quote_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_location_jobber_job_id_idx
  ON jobs (location_id, jobber_job_id)
  WHERE jobber_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_location_jobber_invoice_id_idx
  ON invoices (location_id, jobber_invoice_id)
  WHERE jobber_invoice_id IS NOT NULL;
