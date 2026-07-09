-- One assessment per service request — closes the webhook-race dupe
-- hole (Chelsea Atkins snowball). Companion to the other subrecord
-- indexes in jobber_subrecord_location_scope_unique.sql, with two
-- deliberate differences:
--
--  * NOT partial (no WHERE clause): upsertAssessment now writes via
--    PostgREST upsert with on_conflict=service_request_id, and
--    Postgres can only infer a partial unique index as the ON
--    CONFLICT arbiter when the conflict clause repeats the index
--    predicate — which PostgREST never emits. A partial index here
--    would make every assessment sync fail with 42P10. Non-partial
--    is also safe: NULL service_request_ids never collide (NULLS
--    DISTINCT), and prod has zero NULLs anyway (scanned 7/9/26).
--
--  * No location_id scoping: unlike the jobber_<x>_id columns,
--    service_request_id is our own FK to service_requests' UUID PK —
--    globally unique by construction, so location scoping adds
--    nothing and would change the on_conflict target the code names.
--
-- MUST run AFTER migrations/cleanup_duplicate_assessments.sql — the
-- CREATE fails while duplicate service_request_ids exist.

-- ─── PRE-FLIGHT: must return zero rows ──────────────────────────────
-- SELECT service_request_id, count(*)
--   FROM assessments
--   WHERE service_request_id IS NOT NULL
--   GROUP BY 1 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS assessments_service_request_id_idx
  ON assessments (service_request_id);
