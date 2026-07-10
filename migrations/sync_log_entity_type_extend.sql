-- migrations/sync_log_entity_type_extend.sql
-- ─────────────────────────────────────────────────────────────
-- Extend the legacy sync_log entity_type CHECK to the full set the
-- app writes.
--
-- Found during the 2026-07-10 webhook-observability verification:
-- sync_log_entity_type_check only allows
--   ('client','request','quote','job','invoice','engagement')
-- (probed behaviorally — pg_constraint isn't readable via PostgREST).
-- Every writeSyncLog call with entity_type 'property', 'assessment',
-- or 'location' has been silently REJECTED (fail-soft catch) — which
-- is why PROPERTY_* / ASSESSMENT_DESTROY / APP_DISCONNECT webhooks
-- never produced sync_log rows. This closes that gap; the code
-- already passes the correct values, so rows start landing the
-- moment this runs — no deploy needed.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.sync_log
  DROP CONSTRAINT sync_log_entity_type_check;

ALTER TABLE public.sync_log
  ADD CONSTRAINT sync_log_entity_type_check
  CHECK (entity_type IN (
    'client', 'request', 'quote', 'job', 'invoice',
    'payment', 'note', 'location', 'property', 'assessment',
    'engagement'
  ));

-- Verification (read-only, run after):
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.sync_log'::regclass
--     AND conname = 'sync_log_entity_type_check';
