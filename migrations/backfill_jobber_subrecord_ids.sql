-- Backfill: extract numeric Jobber IDs from base64-encoded GraphQL global IDs
-- stored in sub-record tables by previous imports.
--
-- Mirrors backfill_jobber_client_ids.sql but covers requests/quotes/jobs/
-- invoices/assessments. These were written with the raw GraphQL ID (e.g.
-- "Z2lkOi8vSm9iYmVyL1JlcXVlc3QvOTk5OQ==" decoding to "gid://Jobber/Request/9999")
-- and need the numeric portion so secure.getjobber.com/{type}/{id} links resolve.
--
-- The WHERE clause restricts to non-numeric rows, so each statement is safe
-- to re-run and won't touch rows already in the corrected format.

UPDATE service_requests
SET jobber_request_id = regexp_replace(
  convert_from(decode(jobber_request_id, 'base64'), 'UTF8'),
  '^gid://Jobber/Request/',
  ''
)
WHERE jobber_request_id IS NOT NULL
  AND jobber_request_id NOT SIMILAR TO '[0-9]+';

UPDATE quotes
SET jobber_quote_id = regexp_replace(
  convert_from(decode(jobber_quote_id, 'base64'), 'UTF8'),
  '^gid://Jobber/Quote/',
  ''
)
WHERE jobber_quote_id IS NOT NULL
  AND jobber_quote_id NOT SIMILAR TO '[0-9]+';

UPDATE jobs
SET jobber_job_id = regexp_replace(
  convert_from(decode(jobber_job_id, 'base64'), 'UTF8'),
  '^gid://Jobber/Job/',
  ''
)
WHERE jobber_job_id IS NOT NULL
  AND jobber_job_id NOT SIMILAR TO '[0-9]+';

UPDATE invoices
SET jobber_invoice_id = regexp_replace(
  convert_from(decode(jobber_invoice_id, 'base64'), 'UTF8'),
  '^gid://Jobber/Invoice/',
  ''
)
WHERE jobber_invoice_id IS NOT NULL
  AND jobber_invoice_id NOT SIMILAR TO '[0-9]+';

-- assessments.jobber_assessment_id is currently never written by the import
-- route (which only sets jobber_request_id), but include this for safety in
-- case rows arrived via a different sync path. No-op if all values are null.
UPDATE assessments
SET jobber_assessment_id = regexp_replace(
  convert_from(decode(jobber_assessment_id, 'base64'), 'UTF8'),
  '^gid://Jobber/Assessment/',
  ''
)
WHERE jobber_assessment_id IS NOT NULL
  AND jobber_assessment_id NOT SIMILAR TO '[0-9]+';
