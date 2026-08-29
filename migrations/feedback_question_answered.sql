-- migrations/feedback_question_answered.sql
--
-- feedback_items gains a THIRD owner-fileable type ('question') and a SEVENTH
-- status ('answered').
--
-- HELD: run this by hand (Kevin). The system is LIVE.
--
-- WHY. Owners file questions constantly and the picker forces them to dress
-- one as a bug or an idea ("how do I move her out of nuturing", "will editing
-- an address mess up Jobber", "can we see if emails have been opened" — all
-- live production rows). And a question has no honest ending today: it never
-- ships and it was never declined, so answering one and marking it 'shipped'
-- would email the owner "the problem you reported is fixed" about a problem
-- that never existed. 'answered' is the ending a resolved-with-words item can
-- wear truthfully — and it is deliberately legal on ANY type, because owners
-- mislabel and an admin should be able to answer whatever came in.
--
-- THE COUPLING CONSTRAINT MUST WIDEN TOO, and this is the part that would be
-- easy to get wrong: feedback_items_internal_type_check reads
--     type IN ('bug','feature') OR is_internal
-- and its documented fail-safe direction is "a new type nobody thinks about
-- becomes internal-only by default". 'question' is the first type where that
-- default is WRONG — it is owner-fileable by design — so this migration is the
-- deliberate act of thinking about it: 'question' joins the always-allowed
-- list. decision and hazard stay internal-only, exactly as issue 247 built.
--
-- Constraint names and definitions read from production on 2026-08-30, not
-- assumed:
--   feedback_items_type_check
--     CHECK (type = ANY (ARRAY['bug','feature','decision','hazard']))
--   feedback_items_internal_type_check
--     CHECK ((type = ANY (ARRAY['bug','feature'])) OR is_internal)
--   feedback_items_status_check
--     CHECK (status = ANY (ARRAY['submitted','under_review','planned',
--                                'in_progress','shipped','declined']))
--
-- A CHECK cannot be altered in place; each is dropped and re-added. One
-- transaction — if any re-add fails, no DROP survives alone (a table with no
-- type/status constraint would be worse than either the old state or the new).

BEGIN;

-- 1. type gains 'question'.
ALTER TABLE feedback_items
  DROP CONSTRAINT IF EXISTS feedback_items_type_check;

ALTER TABLE feedback_items
  ADD CONSTRAINT feedback_items_type_check
  CHECK (type = ANY (ARRAY['bug'::text, 'feature'::text, 'question'::text, 'decision'::text, 'hazard'::text]));

-- 2. 'question' is owner-visible: it joins the always-allowed list, so it is
--    legal on internal and non-internal rows alike (same standing as bug and
--    feature). decision/hazard remain internal-only.
ALTER TABLE feedback_items
  DROP CONSTRAINT IF EXISTS feedback_items_internal_type_check;

ALTER TABLE feedback_items
  ADD CONSTRAINT feedback_items_internal_type_check
  CHECK (
    type = ANY (ARRAY['bug'::text, 'feature'::text, 'question'::text])
    OR is_internal
  );

COMMENT ON CONSTRAINT feedback_items_internal_type_check ON feedback_items IS
  'decision/hazard are internal-only; bug/feature/question are owner-visible. type appears in owner-facing payloads (both owner reads select *), so an owner-visible row must never carry a type the owner UI cannot render. Issue 247 step 2, widened for the question type.';

-- 3. status gains 'answered' — the truthful ending for anything resolved with
--    words where nothing shipped. Placed before shipped/declined to keep the
--    array reading as the pipeline order the UI shows.
ALTER TABLE feedback_items
  DROP CONSTRAINT IF EXISTS feedback_items_status_check;

ALTER TABLE feedback_items
  ADD CONSTRAINT feedback_items_status_check
  CHECK (status = ANY (ARRAY['submitted'::text, 'under_review'::text, 'planned'::text, 'in_progress'::text, 'answered'::text, 'shipped'::text, 'declined'::text]));

COMMIT;


-- ─── THE EXISTING ROWS: NOTHING HAPPENS ──────────────────────────────
--
-- Production on 2026-08-30: 82 rows (43 open). Every type is 'bug' or
-- 'feature'; every status is one of the existing six; every row is
-- is_internal=false. All three new constraints are strict SUPERSETS of the old
-- ones, so each ADD CONSTRAINT's validating scan passes all 82 rows. No row is
-- rewritten, no value changes, no backfill, and NO EXISTING ROW CAN VIOLATE
-- the new constraints — a widened domain cannot reject a value the old domain
-- accepted. The scan is instant at 82 rows.
--
-- Reclassifying existing mislabeled rows to 'question' is a SEPARATE, later
-- step (Kevin runs it); this migration only makes those values legal.


-- ─── VERIFY AFTER RUNNING ────────────────────────────────────────────
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.feedback_items'::regclass AND contype = 'c'
--   ORDER BY conname;
--   -- expect: internal_type_check with three always-allowed types,
--   --         status_check with seven values, type_check with five.
--
--   SELECT type, status, count(*) FROM feedback_items GROUP BY 1,2 ORDER BY 1,2;
--   -- expect counts unchanged from before the run.
--
-- Prove the coupling still bites (must ERROR with 23514):
--   UPDATE feedback_items SET type='decision' WHERE is_internal = false;
--
-- And that the new values are live (both must succeed, then ROLLBACK):
--   BEGIN;
--     UPDATE feedback_items SET type='question' WHERE id = (SELECT id FROM feedback_items LIMIT 1);
--     UPDATE feedback_items SET status='answered' WHERE id = (SELECT id FROM feedback_items LIMIT 1);
--   ROLLBACK;


-- ─── ROLLBACK ────────────────────────────────────────────────────────
--
-- Safe ONLY while no row carries 'question' or 'answered'. One transaction,
-- never loose statements (a failed re-add after a committed drop leaves the
-- table unconstrained):
--
--   BEGIN;
--     ALTER TABLE feedback_items DROP CONSTRAINT IF EXISTS feedback_items_type_check;
--     ALTER TABLE feedback_items
--       ADD CONSTRAINT feedback_items_type_check
--       CHECK (type = ANY (ARRAY['bug'::text,'feature'::text,'decision'::text,'hazard'::text]));
--     ALTER TABLE feedback_items DROP CONSTRAINT IF EXISTS feedback_items_internal_type_check;
--     ALTER TABLE feedback_items
--       ADD CONSTRAINT feedback_items_internal_type_check
--       CHECK (type = ANY (ARRAY['bug'::text,'feature'::text]) OR is_internal);
--     ALTER TABLE feedback_items DROP CONSTRAINT IF EXISTS feedback_items_status_check;
--     ALTER TABLE feedback_items
--       ADD CONSTRAINT feedback_items_status_check
--       CHECK (status = ANY (ARRAY['submitted'::text,'under_review'::text,'planned'::text,'in_progress'::text,'shipped'::text,'declined'::text]));
--   COMMIT;
--
-- With such rows present, re-type/re-status them first inside the same
-- transaction, or the final ADDs fail (harmlessly, rolling the whole thing
-- back — the widened constraints stay).
