-- Per-location lead dedup index (already exists in production)
-- Prevents same Jobber client from being linked to two leads
-- within the same location. Critical for send-to-Jobber idempotency.
-- Added to migrations folder so it survives DB rebuilds.
--
-- Safe to run against production — IF NOT EXISTS makes it a no-op
-- since the index already exists in prod.

CREATE UNIQUE INDEX IF NOT EXISTS leads_jobber_client_id_location_idx
ON leads (jobber_client_id, location_id)
WHERE jobber_client_id IS NOT NULL;
