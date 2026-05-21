-- Backfill: extract numeric Client ID from Jobber's base64-encoded GraphQL
-- global IDs stored in leads.jobber_client_id by previous imports.
--
-- Jobber's GraphQL returns IDs like "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzYxMjM5NzY="
-- which decodes to "gid://Jobber/Client/136123976". The numeric portion is
-- what secure.getjobber.com/clients/{id} uses for canonical URLs.
--
-- The WHERE clause restricts to non-numeric rows, so this is safe to re-run
-- and won't touch rows already in the corrected format.

UPDATE leads
SET jobber_client_id = regexp_replace(
  convert_from(decode(jobber_client_id, 'base64'), 'UTF8'),
  '^gid://Jobber/Client/',
  ''
)
WHERE jobber_client_id IS NOT NULL
  AND jobber_client_id NOT SIMILAR TO '[0-9]+';
